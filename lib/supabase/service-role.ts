import "server-only";
import "./ensure-websocket-polyfill";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// This client uses SUPABASE_SERVICE_ROLE_KEY, which bypasses Row Level
// Security entirely (BYPASSRLS role, see supabase/migrations/...init_core_schema.sql
// section 8/9). Per CLAUDE.md non-negotiable #2, that key -- and therefore
// this module -- must NEVER be imported by anything that ends up in a
// client bundle. `server-only` (above) turns an accidental client-side
// import into a build error rather than a leaked secret.
//
// Callers, and why each needs to bypass RLS rather than use the normal
// cookie-bound session client (lib/supabase/server.ts):
//   - The Stripe webhook handler (app/api/webhooks/stripe/route.ts): runs
//     unauthenticated (no end-user session -- Stripe calls it directly), so
//     it has no session client to use at all, and needs to write
//     `subscriptions` / `processed_stripe_events` directly, which per the
//     RLS policies on both tables only service_role is allowed to do.
//   - Organization-invite acceptance (app/actions/invites.ts's
//     acceptInvite, app/invite/accept/page.tsx): RLS structurally forbids
//     an ordinary authenticated session from ever setting
//     organization_invites.status to 'accepted' or self-inserting into
//     organization_members -- see the migration's comments on those
//     policies, and acceptInvite's own doc comment for why every check it
//     makes is therefore load-bearing application logic instead of a
//     second line of defense behind RLS.
//   - The members roster (app/dashboard/members/page.tsx): needs each
//     member's email for display, which lives in the Supabase-managed
//     `auth` schema (not `public`), unreachable from the anon-key session
//     client -- a read-only `auth.admin.getUserById` lookup, scoped to ids
//     an RLS-scoped query already proved belong to the caller's own
//     organization.
export function createServiceRoleClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. " +
        "See .env.example -- for local dev, copy the values `supabase status` prints.",
    );
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      // This client is never attached to an end-user session and never
      // needs to persist/refresh a browser session token.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
