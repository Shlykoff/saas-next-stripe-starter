import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import "@/lib/supabase/ensure-websocket-polyfill";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
// next/headers's cookies() is mocked once, globally, in tests/setup.ts --
// see that file's comment for why this needs to be the SAME jar every test
// file's application code under test reads/writes, not a private mock here.
import { cookieJar } from "./setup";
import { signInAs as sharedSignInAs } from "./auth-helpers";

// ---------------------------------------------------------------------------
// Integration tests for app/actions/note-attachments.ts, run against the
// LOCAL Supabase instance (real Postgres + real Storage, both started by
// `supabase start`), combining two patterns already established elsewhere
// in this suite rather than inventing a third:
//
//   1. tests/notes.test.ts's mocked-cookies signInAs (tests/auth-helpers.ts)
//      to drive the Server Actions themselves (createAttachmentUploadUrl /
//      confirmNoteAttachment / deleteNoteAttachment / getAttachmentDownloadUrl)
//      exactly as a real request would call them.
//   2. tests/notes-realtime.test.ts's raw, un-mocked @supabase/supabase-js
//      client for the one thing the mocked-cookies machinery genuinely
//      cannot do: a real `uploadToSignedUrl` HTTP PUT against local
//      Storage. (Unlike a Realtime subscription, this doesn't need to be
//      SIGNED IN as anyone -- per storage-js's own doc comment on
//      uploadToSignedUrl, "objects table permissions: none" is required,
//      because the signed URL's token itself is the credential. Using a
//      bare anon-key client here, rather than yet another signed-in
//      client, keeps that point visible in the test.)
//
// service_role is used ONLY for test setup/assertion (seeding notes,
// planting an attachment owned by someone else, verifying a row/object's
// final state) -- never to exercise the actual security boundary, matching
// this project's existing convention (see e.g. tests/notes.test.ts,
// tests/notes-realtime.test.ts).
//
// Seed data (supabase/seed.sql):
//   Acme (org 111...)   -- owner_a@example.com (owner), member_a@example.com (member)
//   Globex (org 222...) -- owner_b@example.com (owner), no overlap with Acme
//
// RLS policy logic on note_attachments / storage.objects itself is already
// proven exhaustively at the SQL layer by supabase/tests/note_attachments_test.sql
// (pgTAP) -- these tests deliberately do not re-derive every policy
// combination; they instead prove the app's own Server Action layer
// (validation ordering, error messages, the DB-row-first delete order, the
// no-op-detection pattern) sits correctly on top of that RLS, plus the one
// thing pgTAP explicitly cannot reach: a real Storage HTTP round trip.
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

// service_role client for setup/cleanup/assertion only -- bypasses RLS,
// never used to exercise the behavior under test.
const serviceClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Bare anon-key client, deliberately NOT signed in as anyone -- see header
// comment above for why the real uploadToSignedUrl PUT doesn't need a
// session, only the token minted by createAttachmentUploadUrl.
const rawClient = createClient<Database>(supabaseUrl, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BUCKET = "note-attachments";
const SEED_PASSWORD = "password123";
const ACME_ORG_ID = "11111111-1111-1111-1111-111111111111";
const GLOBEX_ORG_ID = "22222222-2222-2222-2222-222222222222";
const OWNER_A_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_B_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

/** Thin wrapper over tests/auth-helpers.ts's signInAs for the seeded accounts, matching tests/notes.test.ts. */
async function signInAsSeeded(email: string): Promise<void> {
  try {
    await sharedSignInAs(email, SEED_PASSWORD);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (is supabase/seed.sql loaded? run \`supabase db reset\`)`,
    );
  }
}

/**
 * signInAsSeeded, then retries a real getUser() call -- the exact first
 * thing every Server Action under test in this file does -- until it
 * actually succeeds. tests/auth-helpers.ts's signInAs already polls until
 * the session COOKIE KEY appears in the mocked jar, which is enough for
 * every OTHER integration test in this suite, but this file's tests run
 * noticeably longer than those (real, multi-second Storage HTTP round
 * trips for the actual upload/download bytes, not just sub-second Postgres
 * queries) -- and reproduced directly under `npm run test`'s full
 * concurrent suite load: a cookie key being present in the jar does not
 * yet guarantee @supabase/ssr's own internal session parsing has settled,
 * so a fresh createServerSupabaseClient().auth.getUser() call immediately
 * afterward can still throw/return AuthSessionMissingError even though
 * [...cookieJar.keys()] already shows the expected sb-*-auth-token key.
 * Same "poll the real condition, not a fixed delay" philosophy already
 * applied in tests/notes-realtime.test.ts's waitForEvents -- bounded so a
 * genuine sign-in failure still fails fast rather than hanging.
 */
async function signInAs(email: string): Promise<void> {
  const { createServerSupabaseClient } = await import("@/lib/supabase/server");
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await signInAsSeeded(email); // re-clears cookieJar and re-authenticates from scratch each attempt
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const supabase = await createServerSupabaseClient();
      const { data } = await supabase.auth.getUser();
      if (data.user) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // This attempt's session never settled within the window -- re-running
    // signInAsSeeded from scratch (not just polling the same, possibly
    // genuinely-corrupted, cookie value again) is what actually recovers
    // from the case where the FIRST write itself lost the race, not just
    // "hasn't settled yet".
  }

  throw new Error(`Signed in as ${email}, but a fresh getUser() call still reported no session after ${maxAttempts} attempts.`);
}

/**
 * Calls a Server Action while signed in as `email`, retrying the WHOLE
 * re-sign-in + call sequence (up to 3 attempts) if the action's own result
 * comes back with the exact string "You must be signed in." -- every
 * Server Action in app/actions/note-attachments.ts (same convention as
 * app/actions/notes.ts) returns this exact message when a fresh
 * createServerSupabaseClient().auth.getUser() call finds no user, which
 * signInAs's own settle-loop above already mitigates but, empirically
 * (reproduced under `npm run test`'s full concurrent-suite load), does not
 * eliminate outright -- a residual race can still land in the narrow
 * window between that check and this file's own call moments later. A
 * genuine "not authorized" application bug is a DIFFERENT, distinguishable
 * message in every one of these actions (e.g. "Note not found.",
 * "Attachment not found, or you don't have permission..."), so retrying
 * only on this one exact, unambiguous string cannot mask a real regression
 * -- a real bug would never happen to produce this specific message in the
 * first place, and if it somehow did, it would do so deterministically on
 * every retry too.
 */
async function callSignedIn<T extends { error: string | null }>(email: string, action: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let result: T;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await signInAs(email);
    result = await action();
    if (result.error !== "You must be signed in.") return result;
  }
  return result!;
}

async function createTestNote(organizationId: string, authorId: string, title: string): Promise<string> {
  const { data, error } = await serviceClient
    .from("notes")
    .insert({ organization_id: organizationId, author_id: authorId, title, body: "" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("setup insert failed");
  return data.id;
}

// FK-ordered cleanup, mirroring tests/notes-realtime.test.ts's documented
// FK-order comment: storage objects (a separate table Postgres FK cascades
// know nothing about) and note_attachments rows are removed before notes --
// note_attachments.note_id -> notes has ON DELETE CASCADE, so deleting the
// note first would silently take the row with it and this cleanup would
// never actually exercise the explicit delete path, which is worth doing
// honestly here rather than relying on the cascade.
const createdNoteIds: string[] = [];
const createdAttachmentIds: string[] = [];
const createdStoragePaths: string[] = [];

afterAll(async () => {
  if (createdStoragePaths.length > 0) {
    await serviceClient.storage.from(BUCKET).remove(createdStoragePaths);
  }
  if (createdAttachmentIds.length > 0) {
    await serviceClient.from("note_attachments").delete().in("id", createdAttachmentIds);
  }
  if (createdNoteIds.length > 0) {
    await serviceClient.from("notes").delete().in("id", createdNoteIds);
  }
});

beforeEach(() => {
  cookieJar.clear();
});

describe("note attachments: full upload round trip", () => {
  it("a member gets an upload URL, uploads real bytes, confirms, and the row + object both exist afterward", async () => {
    const noteId = await createTestNote(ACME_ORG_ID, OWNER_A_ID, `Attachment round trip ${randomUUID()}`);
    createdNoteIds.push(noteId);

    const { createAttachmentUploadUrl, confirmNoteAttachment } = await import("@/app/actions/note-attachments");

    const fileName = "report.txt";
    const fileContent = "hello attachment, this is a real upload";
    const uploadUrlResult = await callSignedIn("owner_a@example.com", () =>
      createAttachmentUploadUrl(noteId, fileName, fileContent.length, "text/plain"),
    );

    expect(uploadUrlResult.error).toBeNull();
    expect(uploadUrlResult.signedUrl).toBeTruthy();
    expect(uploadUrlResult.token).toBeTruthy();
    // Exact path convention from the migration's header comment:
    // {organization_id}/{note_id}/{uuid}-{sanitized_filename}.
    expect(uploadUrlResult.path).toMatch(
      new RegExp(`^${ACME_ORG_ID}/${noteId}/[0-9a-f-]{36}-report\\.txt$`),
    );

    const path = uploadUrlResult.path as string;
    const token = uploadUrlResult.token as string;

    // The real HTTP round trip: browser (here, a bare un-mocked client) PUTs
    // bytes straight to local Supabase Storage, bypassing this Next.js app
    // entirely -- the whole point of the signed-upload-URL architecture
    // (see app/actions/note-attachments.ts's header comment).
    const { data: uploadData, error: uploadError } = await rawClient.storage
      .from(BUCKET)
      .uploadToSignedUrl(path, token, new Blob([fileContent], { type: "text/plain" }), {
        contentType: "text/plain",
      });
    expect(uploadError).toBeNull();
    expect(uploadData?.path).toBe(path);
    createdStoragePaths.push(path);

    const confirmResult = await callSignedIn("owner_a@example.com", () =>
      confirmNoteAttachment(noteId, path, fileName, "text/plain", fileContent.length),
    );
    expect(confirmResult.error).toBeNull();
    expect(confirmResult.id).toBeTruthy();
    const attachmentId = confirmResult.id as string;
    createdAttachmentIds.push(attachmentId);

    // Verify via service_role -- TEST ASSERTION only, never used to
    // exercise the security boundary itself (that was the signed-in
    // owner_a client, and the token-authorized rawClient PUT, above).
    const { data: row } = await serviceClient
      .from("note_attachments")
      .select("*")
      .eq("id", attachmentId)
      .maybeSingle();
    expect(row).not.toBeNull();
    expect(row?.storage_path).toBe(path);
    expect(row?.note_id).toBe(noteId);
    expect(row?.organization_id).toBe(ACME_ORG_ID);
    expect(row?.uploaded_by).toBe(OWNER_A_ID);

    // The object bytes genuinely exist in Storage too, not just the
    // metadata row -- download and compare content.
    const { data: downloaded, error: downloadError } = await serviceClient.storage.from(BUCKET).download(path);
    expect(downloadError).toBeNull();
    const downloadedText = await downloaded?.text();
    expect(downloadedText).toBe(fileContent);
  });
});

describe("createAttachmentUploadUrl: cross-tenant access", () => {
  it("a non-member gets a generic 'Note not found.' rather than a leaky storage/RLS error", async () => {
    const noteId = await createTestNote(ACME_ORG_ID, OWNER_A_ID, `Cross tenant upload-url test ${randomUUID()}`);
    createdNoteIds.push(noteId);

    const { createAttachmentUploadUrl } = await import("@/app/actions/note-attachments");

    // Globex's owner -- not a member of Acme.
    const result = await callSignedIn("owner_b@example.com", () =>
      createAttachmentUploadUrl(noteId, "secret.txt", 10, "text/plain"),
    );
    expect(result).toEqual({ error: "Note not found." });
  });
});

describe("confirmNoteAttachment: storage path integrity", () => {
  it("rejects a storagePath that doesn't match this note's {organization_id}/{noteId}/ prefix", async () => {
    const noteId = await createTestNote(ACME_ORG_ID, OWNER_A_ID, `Path integrity test ${randomUUID()}`);
    createdNoteIds.push(noteId);

    const { confirmNoteAttachment } = await import("@/app/actions/note-attachments");

    // A syntactically valid path, but for a DIFFERENT note under the same
    // org -- confirmNoteAttachment must reject it rather than silently
    // recording a row whose storage_path doesn't actually correspond to
    // this note.
    const forgedPath = `${ACME_ORG_ID}/${randomUUID()}/${randomUUID()}-forged.txt`;
    const result = await callSignedIn("owner_a@example.com", () =>
      confirmNoteAttachment(noteId, forgedPath, "forged.txt", "text/plain", 10),
    );
    expect(result.error).toBe("Storage path does not match this note.");

    const { data: rows } = await serviceClient.from("note_attachments").select("id").eq("note_id", noteId);
    expect(rows).toEqual([]); // nothing landed
  });
});

describe("deleteNoteAttachment authorization (RLS: uploader or org owner only)", () => {
  it("rejects a non-uploader, non-owner member -- row and object both still exist afterward", async () => {
    const noteId = await createTestNote(ACME_ORG_ID, OWNER_A_ID, `Delete auth test ${randomUUID()}`);
    createdNoteIds.push(noteId);

    // Planted directly via service_role (setup, not the behavior under
    // test) as though owner_a had uploaded it.
    const path = `${ACME_ORG_ID}/${noteId}/${randomUUID()}-owned-by-owner-a.txt`;
    const { error: uploadError } = await serviceClient.storage
      .from(BUCKET)
      .upload(path, new Blob(["content"], { type: "text/plain" }), { contentType: "text/plain" });
    if (uploadError) throw uploadError;
    createdStoragePaths.push(path);

    const { data: attachment, error: attError } = await serviceClient
      .from("note_attachments")
      .insert({
        note_id: noteId,
        organization_id: ACME_ORG_ID,
        uploaded_by: OWNER_A_ID,
        storage_path: path,
        file_name: "owned-by-owner-a.txt",
        content_type: "text/plain",
        size_bytes: 7,
      })
      .select("id")
      .single();
    if (attError || !attachment) throw attError ?? new Error("setup insert failed");
    createdAttachmentIds.push(attachment.id);

    // member_a is a genuine member of Acme, but neither the uploader
    // (owner_a) nor the org owner -- the exact case
    // "note_attachments_delete_uploader_or_owner" must deny.
    const { deleteNoteAttachment } = await import("@/app/actions/note-attachments");

    const result = await callSignedIn("member_a@example.com", () => deleteNoteAttachment(attachment.id));
    expect(result.error).toBe("Attachment not found, or you don't have permission to delete it.");

    const { data: row } = await serviceClient
      .from("note_attachments")
      .select("id")
      .eq("id", attachment.id)
      .maybeSingle();
    expect(row).not.toBeNull(); // still there

    const { data: downloaded, error: downloadError } = await serviceClient.storage.from(BUCKET).download(path);
    expect(downloadError).toBeNull();
    expect(downloaded).not.toBeNull(); // object still there too
  });
});

describe("cross-tenant integrity trigger (trg_note_attachment_organization_matches_note)", () => {
  it(
    "rejects a raw insert whose organization_id is the caller's own org but whose note_id " +
      "actually belongs to a different organization, with the trigger's own exception",
    async () => {
      const otherOrgsNoteId = await createTestNote(GLOBEX_ORG_ID, OWNER_B_ID, `Globex note ${randomUUID()}`);
      createdNoteIds.push(otherOrgsNoteId);

      // genuinely a member (owner) of Acme -- Deliberately bypasses
      // createAttachmentUploadUrl/confirmNoteAttachment's own honest
      // organization_id derivation on purpose -- this exercises the DB
      // trigger directly, at the layer a bug (or a hand-crafted direct
      // PostgREST call skipping the Server Actions entirely) would
      // actually hit.
      const { createServerSupabaseClient } = await import("@/lib/supabase/server");

      // Retries on a bare RLS 42501 rejection -- the same ambiguous "not
      // authenticated" signal callSignedIn retries on above, just shaped
      // differently here because this is a raw insert rather than a Server
      // Action's own {error: string} result: if the mocked session
      // genuinely hasn't settled, this insert runs as an unauthenticated
      // caller and RLS's `is_org_member`/`uploaded_by = auth.uid()` checks
      // reject it with 42501 BEFORE the trigger ever runs -- a real,
      // reproduced-under-load race (see signInAs's doc comment above), not
      // a plausible outcome of a genuine application bug (owner_a
      // genuinely is a member of Acme, so a correctly-authenticated
      // request always clears RLS here and reaches the trigger).
      const maxAttempts = 3;
      let error: { message: string; code?: string } | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await signInAs("owner_a@example.com");
        const supabase = await createServerSupabaseClient();
        const result = await supabase.from("note_attachments").insert({
          note_id: otherOrgsNoteId, // Globex's note
          organization_id: ACME_ORG_ID, // owner_a's own org -- passes RLS's WITH CHECK on its own
          uploaded_by: OWNER_A_ID,
          storage_path: `${ACME_ORG_ID}/${otherOrgsNoteId}/${randomUUID()}-hack.txt`,
          file_name: "hack.txt",
          content_type: "text/plain",
          size_bytes: 1,
        });
        error = result.error;
        if (error?.code !== "42501") break;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/does not match the organization of the referenced note/);

      const { data: rows } = await serviceClient
        .from("note_attachments")
        .select("id")
        .eq("note_id", otherOrgsNoteId);
      expect(rows).toEqual([]); // nothing landed
    },
  );
});
