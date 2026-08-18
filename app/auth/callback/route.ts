import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// OAuth (PKCE) callback endpoint. supabase.auth.signInWithOAuth() (called
// client-side from components/auth/google-oauth-button.tsx) redirects the
// browser to Google, and Google redirects back here with a `code` param.
// Exchanging it here -- server-side -- is what actually creates the session;
// nothing about the OAuth flow itself grants a session until this exchange
// succeeds.
//
// IMPORTANT: this deliberately does NOT use createServerSupabaseClient()
// from lib/supabase/server.ts (the ambient next/headers `cookies()`
// pattern), even though that's the client used everywhere else (Server
// Actions, Server Components) and works fine there. Reproduced live: a real
// Google OAuth round-trip showed exchangeCodeForSession() completing
// successfully server-side (confirmed via `docker logs supabase_auth_saas`
// -- a POST /token with grant_type=pkce returning 200) but the browser never
// ended up with a session afterward -- no subsequent GET /user ever showed
// up in the auth server's logs, meaning the Set-Cookie never reached the
// browser (or wasn't included on the response Next.js actually sent). This
// GET Route Handler returns `NextResponse.redirect(...)`, and Next.js's
// ambient `cookies().set()` mutating a ReadonlyRequestCookies-derived jar
// is not reliably reflected onto a *different*, explicitly-constructed
// NextResponse object returned from a Route Handler -- the same class of
// issue proxy.ts's own comment already calls out for why IT builds cookies
// via request.cookies.getAll() / response.cookies.set() instead of the
// ambient helpers. The fix below applies that same explicit pattern here:
// the `response` object cookies are written onto is the exact same object
// this function returns, so there is no ambiguity about which response the
// Set-Cookie headers end up on.
//
// Only one Route Handler needs auth today, so this cookie adapter is
// inlined rather than factored into a shared lib/ helper -- if a second
// Route Handler needs the same pattern, pull this out then (see proxy.ts
// for the near-identical middleware version, which can't share this exact
// helper since NextRequest cookie mutation there works slightly
// differently -- it mirrors onto both the request and a fresh
// NextResponse.next(), whereas here there's only a single response value).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (code && supabaseUrl && anonKey) {
    // Constructed up front and returned unchanged on success, so every
    // cookie the exchange writes via setAll() below lands on the actual
    // response object the browser receives alongside the redirect --
    // never on some other ambient response Next.js may or may not apply.
    const response = NextResponse.redirect(`${origin}${next}`);

    const supabase = createServerClient(supabaseUrl, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    });

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
}

function safeNextPath(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/onboarding";
}
