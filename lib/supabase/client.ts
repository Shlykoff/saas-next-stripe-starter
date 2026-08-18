"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

// Browser-side Supabase client, used ONLY for the one thing that genuinely
// has to run client-side: kicking off the OAuth redirect
// (supabase.auth.signInWithOAuth navigates window.location itself, which a
// Server Action cannot do -- Server Actions can only return a redirect()
// Next.js itself performs, not hand the browser a `window.location.assign`).
// Email/password sign-up and sign-in do NOT use this client -- those go
// through Server Actions in app/actions/auth.ts using the cookie-bound
// server client, so the session cookie is set in the same response that
// redirects the user onward (see that file for why this matters).
// Uses only the public URL/anon key, same as any other browser code -- safe
// to ship in the client bundle.
export function createBrowserSupabaseClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
