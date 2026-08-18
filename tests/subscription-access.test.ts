import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "@/lib/supabase/ensure-websocket-polyfill";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  hasActiveSubscriptionAccess,
  subscriptionStatusBadgeVariant,
  subscriptionStatusLabel,
} from "@/lib/subscription-access";
import { getActiveOrganization } from "@/lib/org";
import { getOrganizationSubscription } from "@/lib/subscriptions";
import type { Database } from "@/lib/supabase/database.types";

// ---------------------------------------------------------------------------
// Part 1: hasActiveSubscriptionAccess is a pure function -- exhaustively
// unit-testable with no DB/network at all. This is the rule that decides
// whether app/notes/page.tsx renders the paywall or the real content.
// ---------------------------------------------------------------------------
describe("hasActiveSubscriptionAccess", () => {
  it.each([
    ["active", true],
    ["trialing", true],
    ["past_due", false],
    ["canceled", false],
    ["unpaid", false],
    ["incomplete", false],
    ["incomplete_expired", false],
    ["paused", false],
    [null, false],
    [undefined, false],
  ] as const)("status=%s -> access=%s", (status, expected) => {
    expect(hasActiveSubscriptionAccess(status)).toBe(expected);
  });
});

describe("subscriptionStatusLabel / subscriptionStatusBadgeVariant", () => {
  it("labels a missing subscription distinctly from a known status", () => {
    expect(subscriptionStatusLabel(null)).toBe("No subscription");
    expect(subscriptionStatusLabel("active")).toBe("Active");
  });

  it("only uses the 'default' (positive) badge variant for access-granting statuses", () => {
    expect(subscriptionStatusBadgeVariant("active")).toBe("default");
    expect(subscriptionStatusBadgeVariant("trialing")).toBe("default");
    expect(subscriptionStatusBadgeVariant("past_due")).not.toBe("default");
    expect(subscriptionStatusBadgeVariant("canceled")).not.toBe("default");
    expect(subscriptionStatusBadgeVariant(null)).not.toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Part 2: integration test proving the gating that app/notes/page.tsx
// actually performs -- getActiveOrganization + getOrganizationSubscription,
// run through a REAL signed-in, anon-key (RLS-subject) Supabase client, not
// the service_role client -- against the seeded orgs from supabase/seed.sql:
//   Acme (org 111...)   -- owner_a@example.com -- has an ACTIVE subscription
//   Globex (org 222...) -- owner_b@example.com -- has NO subscription row
//
// This is the same pair of functions the Notes page calls before deciding
// whether to render the paywall or the content, run exactly as it runs them
// (session-scoped client, no service_role, no shortcuts) -- so a regression
// that weakens the gate (e.g. switching to a service_role client, or
// dropping the RLS policy) would fail this test, not just a unit test of
// the pure predicate in isolation.
// ---------------------------------------------------------------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Copy .env.example to .env.local (local Supabase must be running: `supabase start`).",
  );
}

const ACME_ORG_ID = "11111111-1111-1111-1111-111111111111";
const GLOBEX_ORG_ID = "22222222-2222-2222-2222-222222222222";

async function signInAs(email: string): Promise<SupabaseClient<Database>> {
  // A fresh client per sign-in, matching one browser session per user --
  // sharing a single client across two signInWithPassword calls would just
  // overwrite the same in-memory session rather than modeling two distinct
  // users querying independently.
  const client = createClient<Database>(supabaseUrl!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: "password123" });
  if (error) {
    throw new Error(`Failed to sign in as ${email} (is supabase/seed.sql loaded? run \`supabase db reset\`): ${error.message}`);
  }
  return client;
}

describe("Notes page gating (real RLS-scoped queries against seed data)", () => {
  let acmeOwnerClient: SupabaseClient<Database>;
  let globexOwnerClient: SupabaseClient<Database>;

  beforeAll(async () => {
    [acmeOwnerClient, globexOwnerClient] = await Promise.all([
      signInAs("owner_a@example.com"),
      signInAs("owner_b@example.com"),
    ]);
  });

  afterAll(async () => {
    await Promise.all([acmeOwnerClient.auth.signOut(), globexOwnerClient.auth.signOut()]);
  });

  it("grants access for Acme (active subscription)", async () => {
    const {
      data: { user },
    } = await acmeOwnerClient.auth.getUser();
    expect(user).not.toBeNull();

    const organization = await getActiveOrganization(acmeOwnerClient, user!.id);
    expect(organization?.id).toBe(ACME_ORG_ID);

    const subscription = await getOrganizationSubscription(acmeOwnerClient, organization!.id);
    expect(subscription?.status).toBe("active");

    // This is the exact call app/notes/page.tsx makes to decide whether to
    // render the paywall -- for Acme it must come back true.
    expect(hasActiveSubscriptionAccess(subscription?.status)).toBe(true);
  });

  it("denies access for Globex (no subscription row at all)", async () => {
    const {
      data: { user },
    } = await globexOwnerClient.auth.getUser();
    expect(user).not.toBeNull();

    const organization = await getActiveOrganization(globexOwnerClient, user!.id);
    expect(organization?.id).toBe(GLOBEX_ORG_ID);

    const subscription = await getOrganizationSubscription(globexOwnerClient, organization!.id);
    expect(subscription).toBeNull();

    // The Notes page must fall through to the paywall for Globex.
    expect(hasActiveSubscriptionAccess(subscription?.status)).toBe(false);
  });

  it(
    "cannot be spoofed by passing another organization's id -- RLS blocks reading Acme's " +
      "active subscription through Globex's session, so gating cannot be fooled by a " +
      "client-supplied organizationId",
    async () => {
      // If this ever returned Acme's row, a malicious/buggy client could
      // pass organizationId=ACME_ORG_ID while signed in as a Globex user
      // and unlock Notes without ever having paid -- this is the exact
      // failure mode "gating must be server-side, not decorative" guards
      // against. RLS policy "subscriptions_select_members" (is_org_member)
      // is what enforces this, independent of anything app code does.
      const subscription = await getOrganizationSubscription(globexOwnerClient, ACME_ORG_ID);
      expect(subscription).toBeNull();
      expect(hasActiveSubscriptionAccess(subscription?.status)).toBe(false);
    },
  );
});
