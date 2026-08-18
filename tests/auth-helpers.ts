import { cookieJar } from "./setup";

/**
 * Signs in as `email` via a real @supabase/ssr server client sharing the
 * mocked cookie jar from tests/setup.ts -- populates cookieJar with a valid
 * session, so the NEXT createServerSupabaseClient() call (made internally by
 * whichever Server Action/page a test invokes afterward) hydrates as that
 * user. Shared by every integration test file that needs a real signed-in
 * session (tests/notes.test.ts, tests/invites.test.ts) rather than each
 * keeping its own copy, since the race documented below is a property of
 * @supabase/ssr itself, not of any one test file's accounts.
 *
 * The actual cookie write is NOT part of the promise signInWithPassword()
 * returns: @supabase/ssr's server client (node_modules/@supabase/ssr/dist/
 * main/createServerClient.js) persists a session change by registering an
 * `onAuthStateChange` listener that -- on a SIGNED_IN event -- awaits
 * applyServerStorage() (which is what ultimately calls our mocked setAll()
 * and writes into cookieJar). That listener is invoked by auth-js's internal
 * subscriber-notification path, which does NOT block signInWithPassword()'s
 * own returned promise on the listener finishing -- confirmed by
 * instrumenting cookieJar directly: immediately after signInWithPassword()
 * resolves, cookieJar can still be empty, and a fresh
 * createServerSupabaseClient() reading it right then throws
 * AuthSessionMissingError even though sign-in genuinely succeeded. This is
 * general to @supabase/ssr + this mocked-cookies setup, independent of which
 * account is signing in or how many other test files are running in
 * parallel (parallel load just makes the race easier to hit in practice).
 * Polling cookieJar itself (rather than re-invoking auth methods on a new
 * client, which risks triggering more of the same async event machinery)
 * until the session cookie actually appears is what makes this
 * deterministic.
 */
export async function signInAs(email: string, password: string): Promise<void> {
  cookieJar.clear();
  const { createServerSupabaseClient } = await import("@/lib/supabase/server");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`Failed to sign in as ${email}: ${error.message}`);
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    const hasSessionCookie = [...cookieJar.keys()].some((name) => /^sb-.*-auth-token/.test(name));
    if (hasSessionCookie) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Signed in as ${email}, but the session cookie never appeared in the mocked jar.`);
}
