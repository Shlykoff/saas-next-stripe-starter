import "server-only";
import "./ensure-websocket-polyfill";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "./database.types";

// Session-bound Supabase client for use inside Server Actions / Route
// Handlers that act on behalf of the currently signed-in user (as opposed
// to lib/supabase/service-role.ts, which bypasses RLS entirely and is only
// for the Stripe webhook). This client uses the *anon* key, so every query
// it makes is still subject to RLS -- e.g. a SELECT on organization_members
// naturally returns nothing if the caller isn't actually a member, which is
// what the Checkout/Portal actions below rely on instead of trusting a
// client-supplied organization_id at face value.
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. " +
        "See .env.example -- for local dev, copy the values `supabase status` prints.",
    );
  }

  return createServerClient<Database>(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render (not a Server Action /
          // Route Handler) -- cookies() is read-only there. Safe to ignore
          // as long as session refresh is also handled in middleware, which
          // is nextjs-frontend's responsibility when it wires up auth.
        }
      },
    },
  });
}
