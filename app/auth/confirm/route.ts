import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";

// Email-confirmation callback. supabase/templates/confirmation.html points
// the confirmation link here (instead of GoTrue's built-in
// `/auth/v1/verify` endpoint, which does an implicit-flow redirect with
// tokens in the URL fragment -- incompatible with this app's server-side
// PKCE session handling via @supabase/ssr). This Route Handler verifies the
// token server-side via verifyOtp() and, on success, holds a real session
// the same way the OAuth flow does.
//
// IMPORTANT: same explicit-cookie pattern as app/auth/callback/route.ts, and
// for the identical reason -- see that file's comment for the full
// reproduction. Short version: Next.js's ambient `cookies().set()` (via
// createServerSupabaseClient() from lib/supabase/server.ts) is not reliably
// reflected onto a *different*, explicitly-constructed NextResponse returned
// from a Route Handler, so cookies must be written directly onto the same
// `response` object this function returns.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(searchParams.get("next"));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (tokenHash && type && supabaseUrl && anonKey) {
    // Constructed up front and returned unchanged on success, so every
    // cookie verifyOtp() writes via setAll() below lands on the actual
    // response object the browser receives alongside the redirect.
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

    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
}

function safeNextPath(raw: string | null): string {
  // Same open-redirect guard as app/auth/callback/route.ts and
  // app/actions/auth.ts's safeNextPath -- formData/query values are
  // client-suppliable and must never be honored as an absolute or
  // protocol-relative URL.
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/onboarding";
}
