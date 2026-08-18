import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// OAuth (PKCE) callback endpoint. supabase.auth.signInWithOAuth() (called
// client-side from components/auth/google-oauth-button.tsx) redirects the
// browser to Google, and Google redirects back here with a `code` param.
// Exchanging it here -- server-side, with the cookie-bound Supabase client
// -- is what actually creates the session cookie; nothing about the OAuth
// flow itself grants a session until this exchange succeeds.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
}

function safeNextPath(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/onboarding";
}
