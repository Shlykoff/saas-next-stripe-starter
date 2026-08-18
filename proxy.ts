import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Route-level auth gate. This is UX (avoid a flash of protected content /
// redirect as early as possible), NOT the security boundary -- the actual
// enforcement is duplicated at the top of every protected server component
// / server action (see app/dashboard/page.tsx, app/notes/page.tsx,
// app/onboarding/page.tsx, app/actions/billing.ts's requireOrgOwner) because
// a middleware matcher is just a path-matching heuristic (easy to
// misconfigure or bypass via route groups/rewrites) and RLS + explicit
// auth.getUser() checks in the data-loading code are what actually stop an
// unauthenticated or wrong-organization request from reading data. Per the
// nextjs-frontend brief: gating must be real server-side checks, not
// "decoration" -- this file alone would be exactly that if it were the only
// check.
const PROTECTED_PREFIXES = ["/dashboard", "/notes", "/onboarding"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// Never protected, and never a path where this middleware should touch
// cookies at all -- see the comment in the function body below for why.
const AUTH_HANDSHAKE_PATHS = ["/auth/callback"];

export async function proxy(request: NextRequest) {
  // /auth/callback is mid-handshake: exchangeCodeForSession() hasn't run
  // yet, so request.cookies here reflects whatever was true BEFORE this
  // OAuth attempt (frequently nothing, but not always -- e.g. right after a
  // sign-out that raced with a still-in-flight request elsewhere holding an
  // older cookie value). Calling getUser() here can't accomplish anything
  // useful (this path was never in PROTECTED_PREFIXES, and any user here is
  // mid-redirect, not browsing content), but it CAN write cookies via
  // setAll() below if that stale/invalid session needs a
  // refresh-or-clear -- and app/auth/callback/route.ts's own comment already
  // documents that this exact codebase has previously hit real bugs from
  // two independent code paths racing to set the same session cookie name
  // on responses to the same request. Skipping this middleware's Supabase
  // client (and therefore all its cookie writes) entirely on this one path
  // removes that whole race class at zero cost: the route handler is the
  // sole authority over cookies during the code exchange either way.
  if (AUTH_HANDSHAKE_PATHS.includes(request.nextUrl.pathname)) {
    return NextResponse.next({ request });
  }

  // Start from a pass-through response; reassigned below if the Supabase
  // client needs to write refreshed session cookies onto it. Mirrors the
  // pattern documented for @supabase/ssr in Next.js middleware: cookies must
  // be mirrored onto BOTH the outgoing request (so this same middleware
  // invocation sees them) and the response (so the browser receives them).
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    // Misconfigured env -- fail closed on protected paths rather than let a
    // broken client silently behave as "no session, but also no redirect".
    if (isProtectedPath(request.nextUrl.pathname)) {
      const loginUrl = new URL("/login", request.url);
      return NextResponse.redirect(loginUrl);
    }
    return response;
  }

  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // IMPORTANT: use getUser(), not getSession(). getSession() only reads the
  // (possibly stale/forged) local cookie; getUser() revalidates against
  // Supabase Auth. This call also transparently refreshes an expiring
  // access token and writes the new cookies via setAll above.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (isProtectedPath(request.nextUrl.pathname) && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Run on everything except static assets / Next internals, so the
    // session cookie stays fresh app-wide -- excluding these paths is a
    // performance optimization, not a security boundary (see comment above).
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
