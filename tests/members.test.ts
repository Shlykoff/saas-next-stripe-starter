import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import "@/lib/supabase/ensure-websocket-polyfill";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { cookieJar } from "./setup";
import { signInAs } from "./auth-helpers";

// ---------------------------------------------------------------------------
// Integration tests for removeMember (app/actions/org.ts), run against the
// LOCAL Supabase instance with real signed-in JWTs -- same approach as
// tests/invites.test.ts, including its reasoning for using DEDICATED
// throwaway users/org (created here, cleaned up in afterAll) rather than the
// shared supabase/seed.sql accounts: vitest runs test files in parallel, and
// this file mutates organization_members rows directly (deleting them),
// which would race other files reading/relying on the seeded Acme roster
// (tests/notes.test.ts, tests/subscription-access.test.ts) if it touched
// that org instead of one entirely private to this file.
//
// Scenarios, per the qa brief for this feature:
//   (a) a non-owner member cannot remove ANOTHER member -- RLS policy
//       "organization_members_delete_owner_or_self" (supabase/migrations/
//       20260817171827_init_core_schema.sql) only allows an owner, or the
//       row's own user, to delete it. Proven end-to-end through the real
//       Server Action, asserting on the only thing that matters either way:
//       the row still exists afterward.
//   (b) the owner CAN remove another member -- the row is actually gone
//       afterward, not just "no error returned".
//   (c) a non-owner CAN remove themselves ("leave") -- same RLS rule's
//       other half (user_id = auth.uid()) -- and the action redirects to
//       /dashboard rather than returning an {error} state.
//   (d) the sole owner of an organization attempting to remove themselves
//       is rejected by trg_prevent_last_owner_change with a friendly,
//       human-readable error (not a raw Postgres exception, not a crash) --
//       this is the trigger interaction the feature spec called out
//       explicitly.
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

const TEST_PASSWORD = "password123";

/**
 * Creates a throwaway, already-confirmed auth user via the admin API -- see
 * tests/invites.test.ts's identical helper for why (no email delivery
 * needed, usable for signInWithPassword immediately).
 */
async function createTestUser(label: string): Promise<{ id: string; email: string }> {
  const email = `members-test-${label}-${randomUUID()}@example.com`;
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

function memberForm(memberId: string): FormData {
  const fd = new FormData();
  fd.set("memberId", memberId);
  return fd;
}

/**
 * Asserts `promise` completed via Next's redirect() -- removeMember redirects
 * to /dashboard when a user removes their OWN membership row ("leave"), same
 * mechanism as acceptInvite (see tests/invites.test.ts's identical helper for
 * why redirect() surfaces as a rejected promise outside a real Next.js
 * request, and why any other rejection or a normal resolution both count as
 * failures here).
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

const createdUserIds: string[] = [];

/**
 * Fresh org + fresh owner/member(s) per test, all inserted directly via
 * service_role (setup, not the behavior under test -- same posture as
 * tests/invites.test.ts's foreignOwner setup: auth.uid() is null for a
 * service_role insert, so trg_new_organization_owner's bootstrap is a no-op
 * by design, and membership rows are assigned explicitly instead).
 */
async function seedOrg(members: Array<{ id: string; role: "owner" | "member" }>): Promise<{
  orgId: string;
  membershipIdByUserId: Map<string, string>;
}> {
  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .insert({ name: "Members Test Org", slug: `members-test-${randomUUID()}` })
    .select("id")
    .single();
  if (orgError || !org) throw orgError ?? new Error("failed to create test org");

  const { data: rows, error: memberError } = await serviceClient
    .from("organization_members")
    .insert(members.map((m) => ({ organization_id: org.id, user_id: m.id, role: m.role })))
    .select("id, user_id");
  if (memberError || !rows) throw memberError ?? new Error("failed to seed members");

  return {
    orgId: org.id,
    membershipIdByUserId: new Map(rows.map((r) => [r.user_id, r.id])),
  };
}

afterAll(async () => {
  for (const id of createdUserIds) {
    // Cascades any remaining organization_members rows for that user, and
    // (if they were the last owner referenced) the organization itself is
    // left orphaned of members but not deleted -- harmless test-only
    // leftover, same tradeoff tests/invites.test.ts accepts for its
    // throwaway orgs.
    await serviceClient.auth.admin.deleteUser(id);
  }
});

describe("removeMember (app/actions/org.ts): non-owner cannot remove another member", () => {
  beforeEach(() => {
    cookieJar.clear();
  });

  it("blocks a non-owner member from removing a different member -- the row survives", async () => {
    const owner = await createTestUser("owner-a");
    const memberA = await createTestUser("member-a");
    const memberB = await createTestUser("member-b");
    createdUserIds.push(owner.id, memberA.id, memberB.id);

    const { membershipIdByUserId } = await seedOrg([
      { id: owner.id, role: "owner" },
      { id: memberA.id, role: "member" },
      { id: memberB.id, role: "member" },
    ]);
    const targetMembershipId = membershipIdByUserId.get(memberB.id);
    if (!targetMembershipId) throw new Error("setup: missing membership id for memberB");

    await signInAs(memberA.email, TEST_PASSWORD); // a plain member, not the owner
    const { removeMember } = await import("@/app/actions/org");

    const result = await removeMember({ error: null }, memberForm(targetMembershipId));

    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/not.*found|permission/i);

    const { data } = await serviceClient
      .from("organization_members")
      .select("id")
      .eq("id", targetMembershipId)
      .maybeSingle();
    expect(data).not.toBeNull(); // still there -- RLS silently blocked the delete
  });
});

describe("removeMember (app/actions/org.ts): owner can remove a member", () => {
  beforeEach(() => {
    cookieJar.clear();
  });

  it("actually deletes the target member's row", async () => {
    const owner = await createTestUser("owner-b");
    const member = await createTestUser("member-c");
    createdUserIds.push(owner.id, member.id);

    const { membershipIdByUserId } = await seedOrg([
      { id: owner.id, role: "owner" },
      { id: member.id, role: "member" },
    ]);
    const targetMembershipId = membershipIdByUserId.get(member.id);
    if (!targetMembershipId) throw new Error("setup: missing membership id for member");

    await signInAs(owner.email, TEST_PASSWORD);
    const { removeMember } = await import("@/app/actions/org");

    const result = await removeMember({ error: null }, memberForm(targetMembershipId));

    expect(result.error).toBeNull();
    expect(result.success).toBe(true);

    const { data } = await serviceClient
      .from("organization_members")
      .select("id")
      .eq("id", targetMembershipId)
      .maybeSingle();
    expect(data).toBeNull(); // actually gone
  });
});

describe("removeMember (app/actions/org.ts): a non-owner can leave voluntarily", () => {
  beforeEach(() => {
    cookieJar.clear();
  });

  it("removes the caller's own row and redirects to /dashboard instead of returning an error state", async () => {
    const owner = await createTestUser("owner-c");
    const member = await createTestUser("member-d");
    createdUserIds.push(owner.id, member.id);

    const { membershipIdByUserId } = await seedOrg([
      { id: owner.id, role: "owner" },
      { id: member.id, role: "member" },
    ]);
    const ownMembershipId = membershipIdByUserId.get(member.id);
    if (!ownMembershipId) throw new Error("setup: missing membership id for member");

    await signInAs(member.email, TEST_PASSWORD);
    const { removeMember } = await import("@/app/actions/org");

    await expectRedirect(removeMember({ error: null }, memberForm(ownMembershipId)), "/dashboard");

    const { data } = await serviceClient
      .from("organization_members")
      .select("id")
      .eq("id", ownMembershipId)
      .maybeSingle();
    expect(data).toBeNull(); // actually gone
  });
});

describe("removeMember (app/actions/org.ts): the sole owner cannot remove themselves", () => {
  beforeEach(() => {
    cookieJar.clear();
  });

  it(
    "is rejected by trg_prevent_last_owner_change with a friendly, human-readable error -- " +
      "not a raw Postgres exception, and the row survives",
    async () => {
      const soleOwner = await createTestUser("sole-owner");
      createdUserIds.push(soleOwner.id);

      const { membershipIdByUserId } = await seedOrg([{ id: soleOwner.id, role: "owner" }]);
      const ownMembershipId = membershipIdByUserId.get(soleOwner.id);
      if (!ownMembershipId) throw new Error("setup: missing membership id for soleOwner");

      await signInAs(soleOwner.email, TEST_PASSWORD);
      const { removeMember } = await import("@/app/actions/org");

      const result = await removeMember({ error: null }, memberForm(ownMembershipId));

      expect(result.error).not.toBeNull();
      // Human-readable, not a raw "P0001" / SQL-flavored message leaking
      // through verbatim.
      expect(result.error).not.toMatch(/P0001/);
      expect(result.error).toMatch(/only owner|last owner/i);

      const { data } = await serviceClient
        .from("organization_members")
        .select("id")
        .eq("id", ownMembershipId)
        .maybeSingle();
      expect(data).not.toBeNull(); // the DELETE was rolled back by the trigger's exception
    },
  );
});
