"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export interface AuthActionState {
  error: string | null;
  /** Non-error informational message (e.g. "check your email to confirm"). */
  info?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors supabase/config.toml's `minimum_password_length = 6` -- validating
// the same rule here isn't just UX polish, it's what lets us show a field-
// level message before ever calling Auth, since Supabase itself would reject
// a shorter password with a generic error anyway. Keep this in sync if that
// config value ever changes.
const MIN_PASSWORD_LENGTH = 6;

function safeNextPath(raw: FormDataEntryValue | null): string {
  const value = typeof raw === "string" ? raw : "";
  // Only ever redirect within this app. formData is client-suppliable, so a
  // value like "https://evil.example" or "//evil.example" must never be
  // honored as an open redirect.
  return value.startsWith("/") && !value.startsWith("//") ? value : "/onboarding";
}

/**
 * Server Action backing the sign-up form (app/(auth)/signup/page.tsx).
 * Validates on the server (never trusts client-side validation alone),
 * creates the auth.users row via Supabase Auth. supabase/config.toml has
 * `auth.email.enable_confirmations = true`, so signUp returns a user with no
 * session -- the account exists but is unconfirmed until the user clicks the
 * link in the confirmation email (see supabase/templates/confirmation.html
 * and app/auth/confirm/route.ts, which is what actually establishes the
 * session once the link is clicked). The `!data.session` branch below is the
 * expected, always-taken path, not a fallback.
 */
export async function signUpWithPassword(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const next = safeNextPath(formData.get("next"));

  if (!EMAIL_RE.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    // Supabase's own message for a duplicate signup ("User already
    // registered") is passed through as-is -- it's already clear to an end
    // user. Anything else (rate limit, weak password rejected server-side
    // despite our client check, etc.) is also just relayed: these are
    // GoTrue's user-facing messages, not internal details.
    return { error: error.message };
  }

  // Anti-enumeration behavior: some Supabase Auth configurations return
  // success (no `error`) for signUp against an email that already has a
  // confirmed account, but with `identities: []` -- no new identity was
  // actually created. Surface this as the same "already registered" case
  // rather than silently redirecting as if a new account had been made.
  if (data.user && data.user.identities?.length === 0) {
    return { error: "An account with this email already exists. Try signing in instead." };
  }

  if (!data.session) {
    // Expected path: email confirmations are enabled (supabase/config.toml),
    // so signUp never returns a session directly. No session yet -- nothing
    // to redirect into; the user confirms via the emailed link instead.
    return {
      error: null,
      info: "Account created. Check your email to confirm your address before signing in.",
    };
  }

  redirect(next);
}

/**
 * Server Action backing the sign-in form (app/(auth)/login/page.tsx).
 */
export async function signInWithPassword(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(formData.get("next"));

  if (!EMAIL_RE.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (!password) {
    return { error: "Enter your password." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // GoTrue intentionally returns the same generic "Invalid login
    // credentials" for both "no such user" and "wrong password" (anti
    // enumeration), which we relay unchanged. "Email not confirmed" is
    // GoTrue's own message for an account that signed up but hasn't clicked
    // the confirmation link yet (auth.email.enable_confirmations = true in
    // supabase/config.toml) -- also relayed as-is, it's already clear to an
    // end user.
    return { error: error.message };
  }

  redirect(next);
}

/** Server Action backing the "Sign out" button in app/layout.tsx. */
export async function signOut(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  // IMPORTANT: `scope: "local"` is not optional here. supabase-js's default
  // scope is "global", which calls GoTrue's POST /logout in a mode that
  // deletes EVERY session row for this user -- not just the one tied to
  // this browser's cookie. Reproduced directly against local GoTrue (no
  // browser needed): create two independent sessions for the same user
  // (e.g. two tabs, or an old session plus a newly-created one), sign out
  // using session A's token with the default scope, and session B --
  // completely unrelated, never touched -- immediately starts failing
  // GET /user with 403 "session_not_found", even though session B's JWT is
  // still cryptographically valid and unexpired. That is the exact error
  // shape reported from the Google OAuth flow (exchangeCodeForSession
  // succeeds server-side, login audit event recorded, then the very next
  // /user call 403s with session_not_found) -- a plausible trigger being
  // any other still-open session for the same account (another tab, a
  // stale prefetch still holding the pre-sign-out cookie, a previous test
  // login) getting swept by this "Sign out" click. `scope: "local"` makes
  // GoTrue revoke only the session this specific request's refresh token
  // belongs to, matching what a "Sign out" button should actually do.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/");
}
