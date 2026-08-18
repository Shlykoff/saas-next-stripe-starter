import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import "@/lib/supabase/ensure-websocket-polyfill";
import { createClient } from "@supabase/supabase-js";
import { validateNoteTitle, validateNoteBody, MAX_NOTE_TITLE_LENGTH } from "@/lib/note-validation";
import type { Database } from "@/lib/supabase/database.types";
// next/headers's cookies() is mocked once, globally, in tests/setup.ts --
// see that file's comment for why this needs to be the SAME jar every test
// file's application code under test reads/writes, not a private mock here.
import { cookieJar } from "./setup";
import { signInAs as sharedSignInAs } from "./auth-helpers";

// ---------------------------------------------------------------------------
// Part 1: validateNoteTitle / validateNoteBody are pure functions -- no
// DB/Next.js request context needed. This is the rule that backs the
// "title is required" check in both createNote and updateNote
// (app/actions/notes.ts).
// ---------------------------------------------------------------------------
describe("validateNoteTitle", () => {
  it("rejects an empty title", () => {
    expect(validateNoteTitle("")).toBe("Title is required.");
  });

  it("rejects a title over the max length", () => {
    expect(validateNoteTitle("x".repeat(MAX_NOTE_TITLE_LENGTH + 1))).toMatch(/too long/);
  });

  it("accepts a normal title", () => {
    expect(validateNoteTitle("Sprint notes")).toBeNull();
  });
});

describe("validateNoteBody", () => {
  it("accepts an empty body (body is optional)", () => {
    expect(validateNoteBody("")).toBeNull();
  });

  it("rejects a body over the max length", () => {
    expect(validateNoteBody("x".repeat(20_001))).toMatch(/too long/);
  });
});

// ---------------------------------------------------------------------------
// Part 2: integration tests for the actual Server Actions in
// app/actions/notes.ts, run against the LOCAL Supabase instance with real
// signed-in JWTs for the seeded users from supabase/seed.sql -- same
// approach as tests/subscription-access.test.ts, extended one level further:
// here we invoke createNote/updateNote/deleteNote themselves (not just the
// RLS-scoped reads they rely on), which requires two things that only
// exist inside a real Next.js request:
//
//   1. next/headers's cookies() -- mocked in tests/setup.ts to an in-memory
//      Map (`cookieJar`, imported above). The SAME mock backs BOTH the "log
//      in as X" step (which writes session cookies into the jar, exactly as
//      @supabase/ssr does for a real browser) and the action's own fresh
//      createServerSupabaseClient() call (which reads them back out) -- so
//      this is the real cookie-round-trip mechanism the library uses across
//      two different requests in production, not a shortcut that bypasses it.
//   2. next/cache's revalidatePath() -- throws ("static generation store
//      missing") outside a real Next.js render; mocked to a no-op in
//      tests/setup.ts so the actions' real success path is reachable here.
//
// Seed data (supabase/seed.sql):
//   Acme (org 111...)   -- owner_a@example.com (owner), member_a@example.com (member)
//   Globex (org 222...) -- owner_b@example.com (owner), no overlap with Acme
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

// service_role client for setup/cleanup only -- bypasses RLS, never used to
// exercise the behavior under test.
const serviceClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ACME_ORG_ID = "11111111-1111-1111-1111-111111111111";
const SEED_PASSWORD = "password123";

/**
 * Signs in as one of supabase/seed.sql's fixed accounts (all sharing
 * SEED_PASSWORD). Thin wrapper over the shared, race-safe signInAs in
 * tests/auth-helpers.ts (see that file's doc comment for why a plain
 * signInWithPassword() call isn't enough on its own) -- kept here so every
 * call site below can stay `signInAs("owner_a@example.com")` rather than
 * threading the password through each one.
 */
async function signInAs(email: string): Promise<void> {
  try {
    await sharedSignInAs(email, SEED_PASSWORD);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (is supabase/seed.sql loaded? run \`supabase db reset\`)`,
    );
  }
}

function noteForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const createdNoteIds: string[] = [];

afterAll(async () => {
  if (createdNoteIds.length > 0) {
    await serviceClient.from("notes").delete().in("id", createdNoteIds);
  }
});

describe("createNote (app/actions/notes.ts)", () => {
  beforeEach(() => {
    cookieJar.clear();
  });

  it("rejects an empty title before ever touching the database", async () => {
    await signInAs("owner_a@example.com");
    const { createNote } = await import("@/app/actions/notes");

    const result = await createNote(
      { error: null },
      noteForm({ organizationId: ACME_ORG_ID, title: "", body: "whatever" }),
    );

    expect(result.error).toBe("Title is required.");
    expect(result.success).toBeUndefined();
  });

  it("lets a real org member create a note, visible afterward via a normal RLS-scoped read", async () => {
    await signInAs("owner_a@example.com");
    const { createNote } = await import("@/app/actions/notes");
    const { getOrganizationNotes } = await import("@/lib/notes");
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");

    const title = `Test note ${randomUUID()}`;
    const result = await createNote(
      { error: null },
      noteForm({ organizationId: ACME_ORG_ID, title, body: "hello" }),
    );

    expect(result.error).toBeNull();
    expect(result.success).toBe(true);

    const supabase = await createServerSupabaseClient();
    const { notes } = await getOrganizationNotes(supabase, ACME_ORG_ID, { pageSize: 100 });
    const created = notes.find((n) => n.title === title);
    expect(created).toBeDefined();
    if (created) createdNoteIds.push(created.id);
  });

  it(
    "is blocked by RLS when organizationId isn't the caller's own org -- a cross-tenant " +
      "insert never lands, even though the client-supplied organizationId shape is valid",
    async () => {
      await signInAs("owner_b@example.com"); // Globex, not a member of Acme
      const { createNote } = await import("@/app/actions/notes");

      const title = `Should never exist ${randomUUID()}`;
      const result = await createNote(
        { error: null },
        noteForm({ organizationId: ACME_ORG_ID, title, body: "" }),
      );

      expect(result.error).not.toBeNull();
      expect(result.success).toBeUndefined();

      const { data } = await serviceClient.from("notes").select("id").eq("title", title);
      expect(data).toEqual([]);
    },
  );
});

describe("updateNote / deleteNote authorization (RLS: author or org owner only)", () => {
  let noteByOwnerA: string;
  let noteByMemberA: string;

  beforeEach(async () => {
    // Fresh notes per test run via service_role (setup, not the behavior
    // under test) so each scenario below starts from a known, isolated state.
    const { data: a, error: aErr } = await serviceClient
      .from("notes")
      .insert({
        organization_id: ACME_ORG_ID,
        author_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", // owner_a
        title: `by owner_a ${randomUUID()}`,
        body: "",
      })
      .select("id")
      .single();
    if (aErr || !a) throw aErr ?? new Error("setup insert failed");
    noteByOwnerA = a.id;
    createdNoteIds.push(noteByOwnerA);

    const { data: m, error: mErr } = await serviceClient
      .from("notes")
      .insert({
        organization_id: ACME_ORG_ID,
        author_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // member_a
        title: `by member_a ${randomUUID()}`,
        body: "",
      })
      .select("id")
      .single();
    if (mErr || !m) throw mErr ?? new Error("setup insert failed");
    noteByMemberA = m.id;
    createdNoteIds.push(noteByMemberA);

    cookieJar.clear();
  });

  it("blocks a non-author, non-owner member from updating someone else's note", async () => {
    await signInAs("member_a@example.com"); // member, not the author of noteByOwnerA
    const { updateNote } = await import("@/app/actions/notes");

    const result = await updateNote(
      { error: null },
      noteForm({ noteId: noteByOwnerA, title: "Hijacked title", body: "" }),
    );

    expect(result.error).toBe("Note not found, or you don't have permission to edit it.");
    expect(result.success).toBeUndefined();

    const { data } = await serviceClient.from("notes").select("title").eq("id", noteByOwnerA).single();
    expect(data?.title).not.toBe("Hijacked title");
  });

  it("blocks a non-author, non-owner member from deleting someone else's note", async () => {
    await signInAs("member_a@example.com");
    const { deleteNote } = await import("@/app/actions/notes");

    const result = await deleteNote({ error: null }, noteForm({ noteId: noteByOwnerA }));

    expect(result.error).toBe("Note not found, or you don't have permission to delete it.");

    const { data } = await serviceClient.from("notes").select("id").eq("id", noteByOwnerA).maybeSingle();
    expect(data).not.toBeNull(); // still there
  });

  it("blocks a member of a completely different organization outright", async () => {
    await signInAs("owner_b@example.com"); // Globex -- not even a member of Acme
    const { updateNote, deleteNote } = await import("@/app/actions/notes");

    const updateResult = await updateNote(
      { error: null },
      noteForm({ noteId: noteByOwnerA, title: "Cross-tenant hijack", body: "" }),
    );
    expect(updateResult.error).not.toBeNull();

    const deleteResult = await deleteNote({ error: null }, noteForm({ noteId: noteByOwnerA }));
    expect(deleteResult.error).not.toBeNull();

    const { data } = await serviceClient.from("notes").select("id").eq("id", noteByOwnerA).maybeSingle();
    expect(data).not.toBeNull();
  });

  it("allows the author to edit their own note", async () => {
    await signInAs("member_a@example.com");
    const { updateNote } = await import("@/app/actions/notes");

    const result = await updateNote(
      { error: null },
      noteForm({ noteId: noteByMemberA, title: "Edited by its own author", body: "" }),
    );

    expect(result.error).toBeNull();
    expect(result.success).toBe(true);
  });

  it("allows the organization owner to edit and delete a note authored by someone else", async () => {
    await signInAs("owner_a@example.com"); // owner of Acme, NOT the author of noteByMemberA

    const { updateNote, deleteNote } = await import("@/app/actions/notes");

    const updateResult = await updateNote(
      { error: null },
      noteForm({ noteId: noteByMemberA, title: "Edited by the org owner", body: "moderated" }),
    );
    expect(updateResult.error).toBeNull();
    expect(updateResult.success).toBe(true);

    const deleteResult = await deleteNote({ error: null }, noteForm({ noteId: noteByMemberA }));
    expect(deleteResult.error).toBeNull();
    expect(deleteResult.success).toBe(true);

    const { data } = await serviceClient.from("notes").select("id").eq("id", noteByMemberA).maybeSingle();
    expect(data).toBeNull(); // actually gone
    createdNoteIds.splice(createdNoteIds.indexOf(noteByMemberA), 1);
  });
});

// ---------------------------------------------------------------------------
// Part 3: getOrganizationNotes (lib/notes.ts) pagination/search/sort --
// the query app/notes/page.tsx now drives from ?page=/?q=/?sort=. Uses a
// dedicated throwaway org + owner (not the shared Acme fixture) so the
// exact note COUNT this section asserts on can't drift depending on
// whatever Part 1/2 above happened to leave lying around at the moment this
// runs, and so it can insert enough notes to actually exercise a second
// page without perturbing those other describe blocks' own assumptions
// about Acme's note count.
// ---------------------------------------------------------------------------
describe("getOrganizationNotes (lib/notes.ts): pagination, search, sort", () => {
  const TEST_PASSWORD = "password123";
  let ownerId: string;
  let ownerEmail: string;
  let orgId: string;
  const noteIds: string[] = [];

  // 25 notes, explicit (spaced) created_at so "newest"/"oldest" ordering is
  // deterministic regardless of how fast these inserts actually land --
  // titles chosen so a substring search ("Sprint") matches a known subset
  // and title-ascending sort has an unambiguous expected order.
  const NOTE_COUNT = 25;
  const SEARCH_MATCH_COUNT = 5; // "Sprint 00".."Sprint 04"

  beforeAll(async () => {
    const email = `notes-paging-${randomUUID()}@example.com`;
    const { data: user, error: userError } = await serviceClient.auth.admin.createUser({
      email,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (userError || !user.user) throw userError ?? new Error("failed to create paging test user");
    ownerId = user.user.id;
    ownerEmail = email;

    const { data: org, error: orgError } = await serviceClient
      .from("organizations")
      .insert({ name: "Paging Test Org", slug: `paging-test-${randomUUID()}` })
      .select("id")
      .single();
    if (orgError || !org) throw orgError ?? new Error("failed to create paging test org");
    orgId = org.id;

    const { error: memberError } = await serviceClient
      .from("organization_members")
      .insert({ organization_id: orgId, user_id: ownerId, role: "owner" });
    if (memberError) throw memberError;

    const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);
    const rows = Array.from({ length: NOTE_COUNT }, (_, i) => ({
      organization_id: orgId,
      author_id: ownerId,
      // First 5 titles are findable by the "Sprint" search below; the rest
      // are alphabetically distinct ("Zzz 05".."Zzz 24") so title_asc has a
      // single unambiguous expected order together with the Sprint notes.
      title: i < SEARCH_MATCH_COUNT ? `Sprint 0${i} planning` : `Zzz note ${String(i).padStart(2, "0")}`,
      body: i < SEARCH_MATCH_COUNT ? "agenda: sprint review" : "",
      // Spaced 1 minute apart, strictly increasing with i -- note 0 is
      // oldest, note 24 is newest.
      created_at: new Date(baseTime + i * 60_000).toISOString(),
    }));

    const { data: inserted, error: insertError } = await serviceClient.from("notes").insert(rows).select("id");
    if (insertError || !inserted) throw insertError ?? new Error("failed to seed paging test notes");
    noteIds.push(...inserted.map((r) => r.id));
  });

  afterAll(async () => {
    // FK order matters: notes.author_id -> auth.users has no ON DELETE
    // action (RESTRICT, see supabase/migrations/20260817212642_add_notes.sql),
    // so the notes must go before the user; the organization is deleted
    // before the user too, cascading organization_members.
    if (noteIds.length > 0) {
      await serviceClient.from("notes").delete().in("id", noteIds);
    }
    if (orgId) {
      await serviceClient.from("organizations").delete().eq("id", orgId);
    }
    if (ownerId) {
      await serviceClient.auth.admin.deleteUser(ownerId);
    }
  });

  beforeEach(async () => {
    cookieJar.clear();
    await sharedSignInAs(ownerEmail, TEST_PASSWORD);
  });

  it("defaults to newest-first, page 1, 20 per page, with correct totals", async () => {
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    const { getOrganizationNotes } = await import("@/lib/notes");
    const supabase = await createServerSupabaseClient();

    const result = await getOrganizationNotes(supabase, orgId);

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.totalCount).toBe(NOTE_COUNT);
    expect(result.totalPages).toBe(2);
    expect(result.notes).toHaveLength(20);
    // Newest first: note 24 (last inserted, latest created_at) leads.
    expect(result.notes[0].title).toBe("Zzz note 24");
  });

  it("returns the remaining notes on page 2", async () => {
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    const { getOrganizationNotes } = await import("@/lib/notes");
    const supabase = await createServerSupabaseClient();

    const result = await getOrganizationNotes(supabase, orgId, { page: 2 });

    expect(result.page).toBe(2);
    expect(result.notes).toHaveLength(NOTE_COUNT - 20);
    // Oldest 5 notes (Sprint 00..04) land on page 2 under newest-first sort.
    expect(result.notes.every((n) => n.title.startsWith("Sprint"))).toBe(true);
  });

  it("sorts oldest-first when requested", async () => {
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    const { getOrganizationNotes } = await import("@/lib/notes");
    const supabase = await createServerSupabaseClient();

    const result = await getOrganizationNotes(supabase, orgId, { sort: "oldest", pageSize: NOTE_COUNT });

    expect(result.notes[0].title).toBe("Sprint 00 planning");
    expect(result.notes[result.notes.length - 1].title).toBe("Zzz note 24");
  });

  it("sorts title A-Z when requested", async () => {
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    const { getOrganizationNotes } = await import("@/lib/notes");
    const supabase = await createServerSupabaseClient();

    const result = await getOrganizationNotes(supabase, orgId, { sort: "title_asc", pageSize: NOTE_COUNT });

    const titles = result.notes.map((n) => n.title);
    const sorted = [...titles].sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(sorted);
    expect(titles[0]).toMatch(/^Sprint/); // "Sprint..." sorts before "Zzz..."
  });

  it("filters by search term across title and body, case-insensitively", async () => {
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    const { getOrganizationNotes } = await import("@/lib/notes");
    const supabase = await createServerSupabaseClient();

    const result = await getOrganizationNotes(supabase, orgId, { search: "sprint" });

    expect(result.totalCount).toBe(SEARCH_MATCH_COUNT);
    expect(result.notes).toHaveLength(SEARCH_MATCH_COUNT);
    expect(result.notes.every((n) => n.title.startsWith("Sprint"))).toBe(true);
  });

  it("returns an empty page (not an error) for a search term matching nothing", async () => {
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    const { getOrganizationNotes } = await import("@/lib/notes");
    const supabase = await createServerSupabaseClient();

    const result = await getOrganizationNotes(supabase, orgId, { search: "no such note anywhere" });

    expect(result.totalCount).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it(
    "a search term containing filter-syntax-reserved characters (comma, parens) doesn't corrupt the " +
      "query or leak other notes -- it's escaped, not interpreted as PostgREST .or() syntax",
    async () => {
      const { createServerSupabaseClient } = await import("@/lib/supabase/server");
      const { getOrganizationNotes } = await import("@/lib/notes");
      const supabase = await createServerSupabaseClient();

      const result = await getOrganizationNotes(supabase, orgId, { search: "sprint, planning (weekly)" });

      // Matches nothing (no note contains that exact literal substring),
      // but critically must not throw / return unrelated rows / return
      // every row -- all of which is what a broken (unescaped) filter
      // string could do instead.
      expect(result.totalCount).toBe(0);
      expect(result.notes).toEqual([]);
    },
  );

  it("is scoped by organization RLS the same as the unpaginated read -- a non-member gets nothing", async () => {
    cookieJar.clear();
    await sharedSignInAs("owner_b@example.com", "password123"); // Globex, not a member of this throwaway org
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    const { getOrganizationNotes } = await import("@/lib/notes");
    const supabase = await createServerSupabaseClient();

    const result = await getOrganizationNotes(supabase, orgId);

    expect(result.totalCount).toBe(0);
    expect(result.notes).toEqual([]);
  });
});
