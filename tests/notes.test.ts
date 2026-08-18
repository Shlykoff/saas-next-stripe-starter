import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
    const notes = await getOrganizationNotes(supabase, ACME_ORG_ID);
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
