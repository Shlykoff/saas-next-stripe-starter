import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import "@/lib/supabase/ensure-websocket-polyfill";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
// Shared mocked cookie jar for next/headers's cookies() -- see
// tests/setup.ts's comment. Same "sign in as X" mechanism as
// tests/notes.test.ts: a real @supabase/ssr server client writes session
// cookies into this jar, and the Server Actions under test read them back
// out via their own createServerSupabaseClient() call.
import { cookieJar } from "./setup";
import { signInAs } from "./auth-helpers";

// ---------------------------------------------------------------------------
// Integration tests for app/actions/invites.ts, run against the LOCAL
// Supabase instance with real signed-in JWTs -- same approach as
// tests/notes.test.ts, but with DEDICATED throwaway users created here
// (via the admin API, cleaned up in afterAll) rather than the shared seeded
// accounts from supabase/seed.sql. This matters because vitest runs every
// test *file* in parallel by default: supabase/seed.sql's owner_b@example.com
// is also signed in concurrently by tests/subscription-access.test.ts's
// beforeAll and by a case in tests/notes.test.ts, and doing the same here
// occasionally raced @supabase/ssr's async, event-driven cookie persistence
// (signInWithPassword's promise resolves before the onAuthStateChange
// listener that actually writes the session cookie has necessarily run --
// see signInAs's own comment) into an intermittent "signed in, but the very
// next request reads no session" failure under full-suite load. Using
// throwaway users this file alone touches removes that shared-fixture
// contention at the root, rather than papering over a symptom.
//
// Two scenarios, per the qa brief for this feature:
//   (a) a non-owner cannot create an invite. createInvite() is blocked in
//       TWO independent layers here -- lib/org.ts's requireOrgOwner (an
//       app-level membership check, itself RLS-scoped) rejects before ever
//       attempting the INSERT, and even if that check were ever removed or
//       buggy, RLS policy "organization_invites_insert_owner" would still
//       independently reject the raw INSERT (proven directly at the SQL
//       level, non-owner and cross-org cases both, in
//       supabase/tests/organization_invites_test.sql). This test exercises
//       the real action end-to-end and asserts on the only thing that
//       actually matters either way: no row gets created.
//   (b) accepting an invite while signed in as the wrong email is rejected
//       by acceptInvite's own re-verification (not just page-level UX) --
//       and neither the organization_members INSERT nor the
//       organization_invites status update happen.
// ---------------------------------------------------------------------------

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY. " +
      "Copy .env.example to .env.local (local Supabase must be running: `supabase start`).",
  );
}

// service_role client for setup/cleanup/verification only -- bypasses RLS,
// never used to exercise the behavior under test.
const serviceClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ACME_ORG_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEST_PASSWORD = "password123";

/**
 * Creates a throwaway, already-confirmed auth user via the admin API -- no
 * email delivery involved (email_confirm: true), so it's usable for
 * signInWithPassword immediately. See this file's top comment for why these
 * are dedicated per-file users rather than the shared seed.sql accounts.
 */
async function createTestUser(label: string): Promise<{ id: string; email: string }> {
  const email = `invites-test-${label}-${randomUUID()}@example.com`;
  const { data, error } = await serviceClient.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw error ?? new Error(`Failed to create test user ${email}`);
  }
  return { id: data.user.id, email };
}

// signInAs(email, password) is imported from ./auth-helpers -- shared,
// race-safe implementation (see that file's doc comment); every user this
// test file signs in as uses TEST_PASSWORD, so call sites below pass that
// explicitly (`signInAs(user.email, TEST_PASSWORD)`).

function inviteForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/**
 * Asserts `promise` completed via Next's redirect() (app/actions/invites.ts's
 * acceptInvite redirects to /dashboard on success -- it has no other success
 * path). redirect() works by throwing a special error whose `digest` encodes
 * `NEXT_REDIRECT;<type>;<url>;<statusCode>;` (see
 * node_modules/next/dist/client/components/redirect.js) -- outside a real
 * Next.js render/request there's no framework runtime to catch that throw
 * and perform the actual navigation, so from a plain async-function-call
 * perspective it surfaces as a rejected promise. Any OTHER rejection (a real
 * bug) is rethrown rather than swallowed, and a normal (non-throwing)
 * resolution is treated as a failure too, since acceptInvite has no
 * success return value -- silently resolving would mean it exited some
 * other way than the redirect this assertion expects.
 */
async function expectRedirect(promise: Promise<unknown>, pathIncludes: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const digest = (err as { digest?: string } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;") && digest.includes(pathIncludes)) {
      return;
    }
    throw err;
  }
  throw new Error(`Expected a redirect to a path including "${pathIncludes}", but the call returned normally.`);
}

let nonOwnerMember: { id: string; email: string };
let foreignOwner: { id: string; email: string };
let mismatchUser: { id: string; email: string };
let foreignOrgId: string;

const createdInviteIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  [nonOwnerMember, foreignOwner, mismatchUser] = await Promise.all([
    createTestUser("non-owner-member"),
    createTestUser("foreign-owner"),
    createTestUser("mismatch"),
  ]);
  createdUserIds.push(nonOwnerMember.id, foreignOwner.id, mismatchUser.id);

  // nonOwnerMember: a real (non-owner) member of the seeded Acme org, for
  // the "non-owner cannot invite" case.
  const { error: memberError } = await serviceClient
    .from("organization_members")
    .insert({ organization_id: ACME_ORG_ID, user_id: nonOwnerMember.id, role: "member" });
  if (memberError) throw memberError;

  // foreignOwner: owner of a completely separate organization, for the
  // "owner of a DIFFERENT org cannot invite into Acme" case. Inserted
  // directly as service_role (no JWT / auth.uid() is null here), so the
  // trg_new_organization_owner bootstrap trigger is a no-op by design --
  // same reasoning as supabase/seed.sql's own comment for Acme/Globex --
  // membership is assigned explicitly right after.
  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .insert({ name: "Invites Test Foreign Org", slug: `invites-test-foreign-${randomUUID()}` })
    .select("id")
    .single();
  if (orgError || !org) throw orgError ?? new Error("failed to create foreign org");
  foreignOrgId = org.id;

  const { error: foreignMemberError } = await serviceClient
    .from("organization_members")
    .insert({ organization_id: foreignOrgId, user_id: foreignOwner.id, role: "owner" });
  if (foreignMemberError) throw foreignMemberError;

  // mismatchUser: deliberately given no organization membership at all --
  // only used to be signed in as "the wrong person" for an invite addressed
  // to someone else.
});

afterAll(async () => {
  if (createdInviteIds.length > 0) {
    await serviceClient.from("organization_invites").delete().in("id", createdInviteIds);
  }
  if (foreignOrgId) {
    // Cascades organization_members for foreignOrgId (on delete cascade,
    // see supabase/migrations/20260817171827_init_core_schema.sql).
    await serviceClient.from("organizations").delete().eq("id", foreignOrgId);
  }
  for (const id of createdUserIds) {
    // Cascades any remaining organization_members rows for that user (on
    // delete cascade on user_id) -- e.g. nonOwnerMember's Acme membership.
    await serviceClient.auth.admin.deleteUser(id);
  }
});

describe("createInvite (app/actions/invites.ts): non-owner cannot invite", () => {
  beforeEach(() => {
    cookieJar.clear();
  });

  it("blocks a non-owner member from creating an invite -- no row is ever created", async () => {
    await signInAs(nonOwnerMember.email, TEST_PASSWORD); // member of Acme, NOT owner
    const { createInvite } = await import("@/app/actions/invites");

    const email = `never-invited-${randomUUID()}@example.com`;

    // requireOrgOwner (lib/org.ts) throws for a non-owner rather than
    // returning an {error} state -- same shape as
    // app/actions/billing.ts's createCheckoutSession/createPortalSession,
    // which lean on the identical shared helper.
    await expect(
      createInvite({ error: null }, inviteForm({ organizationId: ACME_ORG_ID, email, role: "member" })),
    ).rejects.toThrow(/owner/i);

    const { data } = await serviceClient.from("organization_invites").select("id").eq("email", email);
    expect(data).toEqual([]);
  });

  it("blocks an owner of a DIFFERENT organization from inviting into Acme", async () => {
    await signInAs(foreignOwner.email, TEST_PASSWORD); // owner of foreignOrgId, not a member of Acme at all
    const { createInvite } = await import("@/app/actions/invites");

    const email = `cross-tenant-invite-${randomUUID()}@example.com`;

    await expect(
      createInvite({ error: null }, inviteForm({ organizationId: ACME_ORG_ID, email, role: "owner" })),
    ).rejects.toThrow(/owner/i);

    const { data } = await serviceClient.from("organization_invites").select("id").eq("email", email);
    expect(data).toEqual([]);
  });
});

describe("acceptInvite (app/actions/invites.ts): email mismatch is rejected", () => {
  let inviteToken: string;
  let inviteId: string;
  let inviteEmail: string;

  beforeEach(async () => {
    cookieJar.clear();
    // A fresh, unique email per test (not just per describe block) -- the
    // partial unique index organization_invites_org_email_pending_idx
    // allows only one PENDING invite per (organization, email), and this
    // describe's tests deliberately never move their invite out of pending,
    // so reusing one email across tests would collide with the previous
    // test's still-pending row.
    inviteEmail = `invited-${randomUUID()}@example.com`;

    // Fresh pending invite per test run, inserted via service_role (setup,
    // not the behavior under test) -- addressed to an email that belongs to
    // NEITHER seeded user this test signs in as, so the mismatch is
    // unambiguous either way.
    const { data, error } = await serviceClient
      .from("organization_invites")
      .insert({
        organization_id: ACME_ORG_ID,
        email: inviteEmail,
        role: "member",
        invited_by: OWNER_A_ID,
      })
      .select("id, token")
      .single();
    if (error || !data) throw error ?? new Error("setup insert failed");
    inviteId = data.id;
    inviteToken = data.token;
    createdInviteIds.push(inviteId);
  });

  it(
    "rejects acceptance when the signed-in user's email doesn't match the invite's -- " +
      "no membership is granted and the invite stays pending",
    async () => {
      // mismatchUser is a real, confirmed account, but it is NOT inviteEmail
      // -- exactly the "signed in as the wrong account" case acceptInvite
      // must re-verify itself (per its own doc comment) rather than trust
      // that app/invite/accept/page.tsx already checked.
      await signInAs(mismatchUser.email, TEST_PASSWORD);
      const { acceptInvite } = await import("@/app/actions/invites");

      const formData = new FormData();
      formData.set("token", inviteToken);

      const result = await acceptInvite({ error: null }, formData);

      expect(result.error).not.toBeNull();
      expect(result.error).toContain(inviteEmail);
      expect(result.error).toContain(mismatchUser.email);

      // Neither privileged write happened.
      const { data: membership } = await serviceClient
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", ACME_ORG_ID)
        .eq("user_id", mismatchUser.id)
        .maybeSingle();
      expect(membership).toBeNull();

      const { data: invite } = await serviceClient
        .from("organization_invites")
        .select("status, accepted_at, accepted_by")
        .eq("id", inviteId)
        .single();
      expect(invite?.status).toBe("pending");
      expect(invite?.accepted_at).toBeNull();
      expect(invite?.accepted_by).toBeNull();
    },
  );

  it("rejects an unknown/garbage token the same way as an invalid invite", async () => {
    await signInAs(mismatchUser.email, TEST_PASSWORD);
    const { acceptInvite } = await import("@/app/actions/invites");

    const formData = new FormData();
    formData.set("token", randomUUID()); // well-formed uuid, but no matching row

    const result = await acceptInvite({ error: null }, formData);
    expect(result.error).toBe("This invite is no longer valid.");
  });
});

describe("acceptInvite (app/actions/invites.ts): happy path + concurrency", () => {
  // Unlike the mismatch-describe block above, these tests actually succeed
  // in granting membership -- track and clean up the resulting
  // organization_members rows too, not just the invite rows.
  const createdMemberships: Array<{ organization_id: string; user_id: string }> = [];

  afterAll(async () => {
    for (const m of createdMemberships) {
      await serviceClient
        .from("organization_members")
        .delete()
        .eq("organization_id", m.organization_id)
        .eq("user_id", m.user_id);
    }
  });

  it("on success, creates the organization_members row with the invited role and marks the invite accepted", async () => {
    const invitee = await createTestUser("happy-path");
    createdUserIds.push(invitee.id);

    const { data: invite, error: insertError } = await serviceClient
      .from("organization_invites")
      .insert({
        organization_id: ACME_ORG_ID,
        email: invitee.email,
        role: "member",
        invited_by: OWNER_A_ID,
      })
      .select("id, token")
      .single();
    if (insertError || !invite) throw insertError ?? new Error("setup insert failed");
    createdInviteIds.push(invite.id);

    await signInAs(invitee.email, TEST_PASSWORD);
    const { acceptInvite } = await import("@/app/actions/invites");

    const formData = new FormData();
    formData.set("token", invite.token);

    await expectRedirect(acceptInvite({ error: null }, formData), "/dashboard");
    createdMemberships.push({ organization_id: ACME_ORG_ID, user_id: invitee.id });

    const { data: membership } = await serviceClient
      .from("organization_members")
      .select("role")
      .eq("organization_id", ACME_ORG_ID)
      .eq("user_id", invitee.id)
      .single();
    expect(membership?.role).toBe("member");

    const { data: acceptedInvite } = await serviceClient
      .from("organization_invites")
      .select("status, accepted_at, accepted_by")
      .eq("id", invite.id)
      .single();
    expect(acceptedInvite?.status).toBe("accepted");
    expect(acceptedInvite?.accepted_at).not.toBeNull();
    expect(acceptedInvite?.accepted_by).toBe(invitee.id);
  });

  it(
    "a concurrent double-accept of the same token creates exactly one membership row, " +
      "with no crash and no duplicate",
    async () => {
      const invitee = await createTestUser("concurrent");
      createdUserIds.push(invitee.id);

      const { data: invite, error: insertError } = await serviceClient
        .from("organization_invites")
        .insert({
          organization_id: ACME_ORG_ID,
          email: invitee.email,
          role: "owner",
          invited_by: OWNER_A_ID,
        })
        .select("id, token")
        .single();
      if (insertError || !invite) throw insertError ?? new Error("setup insert failed");
      createdInviteIds.push(invite.id);

      await signInAs(invitee.email, TEST_PASSWORD);
      const { acceptInvite } = await import("@/app/actions/invites");

      // Two independent FormData instances for the SAME token, submitted
      // concurrently against the SAME signed-in session -- this is exactly
      // what a double-submitted "Accept invite" click (or two tabs) would
      // produce. Both are expected to succeed (redirect): acceptInvite's own
      // doc comment explains why this is idempotent -- whichever INSERT
      // loses the race to organization_members' unique constraint hits the
      // 23505 branch (see the role-reconciliation fix above) instead of
      // erroring, and the invite's `.eq("status", "pending")` UPDATE guard
      // means whichever request updates second just affects zero rows
      // rather than erroring.
      const formData1 = new FormData();
      formData1.set("token", invite.token);
      const formData2 = new FormData();
      formData2.set("token", invite.token);

      await Promise.all([
        expectRedirect(acceptInvite({ error: null }, formData1), "/dashboard"),
        expectRedirect(acceptInvite({ error: null }, formData2), "/dashboard"),
      ]);
      createdMemberships.push({ organization_id: ACME_ORG_ID, user_id: invitee.id });

      const { data: memberships } = await serviceClient
        .from("organization_members")
        .select("id, role")
        .eq("organization_id", ACME_ORG_ID)
        .eq("user_id", invitee.id);
      expect(memberships).toHaveLength(1);
      expect(memberships?.[0]?.role).toBe("owner");

      const { data: acceptedInvite } = await serviceClient
        .from("organization_invites")
        .select("status, accepted_by")
        .eq("id", invite.id)
        .single();
      expect(acceptedInvite?.status).toBe("accepted");
      expect(acceptedInvite?.accepted_by).toBe(invitee.id);
    },
  );

  it(
    "regression: accepting a re-invite for someone who is ALREADY a member with a " +
      "different role actually updates their role, instead of a silent no-op",
    async () => {
      const member = await createTestUser("role-upgrade");
      createdUserIds.push(member.id);

      // member is already a real 'member' of Acme -- simulates the only
      // scenario this bug could occur in: there's no dedicated "change
      // role" UI yet, so re-inviting is currently the sole mechanism an
      // owner has for promoting/demoting an existing member (see
      // components/invites/invite-member-form.tsx and acceptInvite's own
      // doc comment on the 23505 branch below).
      const { error: memberInsertError } = await serviceClient
        .from("organization_members")
        .insert({ organization_id: ACME_ORG_ID, user_id: member.id, role: "member" });
      if (memberInsertError) throw memberInsertError;
      createdMemberships.push({ organization_id: ACME_ORG_ID, user_id: member.id });

      // Owner re-invites the same email, this time as 'owner'.
      const { data: invite, error: insertError } = await serviceClient
        .from("organization_invites")
        .insert({
          organization_id: ACME_ORG_ID,
          email: member.email,
          role: "owner",
          invited_by: OWNER_A_ID,
        })
        .select("id, token")
        .single();
      if (insertError || !invite) throw insertError ?? new Error("setup insert failed");
      createdInviteIds.push(invite.id);

      await signInAs(member.email, TEST_PASSWORD);
      const { acceptInvite } = await import("@/app/actions/invites");

      const formData = new FormData();
      formData.set("token", invite.token);

      // Before the fix: the INSERT into organization_members hit 23505
      // (unique_violation on (organization_id, user_id)), was treated as
      // "already a member, nothing to do," and execution continued straight
      // to marking the invite accepted -- the existing row's role was never
      // touched. The invitee was redirected to /dashboard believing they
      // were now owner, with no error shown to them or the inviting owner,
      // while their actual role silently stayed 'member'.
      await expectRedirect(acceptInvite({ error: null }, formData), "/dashboard");

      const { data: membershipAfter } = await serviceClient
        .from("organization_members")
        .select("role")
        .eq("organization_id", ACME_ORG_ID)
        .eq("user_id", member.id)
        .single();
      expect(membershipAfter?.role).toBe("owner"); // was 'member' -- must actually change, not silently stay

      const { data: acceptedInvite } = await serviceClient
        .from("organization_invites")
        .select("status")
        .eq("id", invite.id)
        .single();
      expect(acceptedInvite?.status).toBe("accepted");
    },
  );
});
