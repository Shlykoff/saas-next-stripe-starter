"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_NOTE,
  NOTE_ATTACHMENTS_BUCKET,
  isAllowedAttachmentMimeType,
} from "@/lib/note-attachments-config";

// ============================================================================
// Server Actions backing the note-attachments upload/download/delete flow
// (components/notes/attachment-upload.tsx, components/notes/note-
// attachments-list.tsx).
//
// Architecture: the browser uploads file bytes DIRECTLY to Supabase Storage
// via a short-lived signed upload URL, never through this Next.js app --
//
//   1. createAttachmentUploadUrl (here) -- validates, then mints a signed
//      upload URL scoped to one exact storage path.
//   2. uploadToSignedUrl (browser -> Supabase Storage directly, called from
//      components/notes/attachment-upload.tsx via the browser Supabase
//      client) -- the actual bytes never pass through a Vercel serverless
//      function, which caps request bodies at ~4.5MB. A multi-MB file sent
//      through a Server Action instead would hit that ceiling well before
//      hitting this bucket's own 10 MiB limit.
//   3. confirmNoteAttachment (here) -- records the DB metadata row now that
//      the bytes are confirmed to exist in Storage.
//
// Every one of these goes through the session-bound client from
// createServerSupabaseClient() (anon key, RLS-enforced) -- never
// service_role. RLS (supabase/migrations/20260818222947_add_note_attachments.sql)
// structurally allows a normal session to perform every one of these
// operations for their own organization already, so there is nothing here
// that needs to bypass it.
//
// Explicitly OUT of scope, a deliberate known limitation: no cleanup job
// for orphaned uploads. createAttachmentUploadUrl can issue a signed URL and
// the browser can genuinely PUT bytes to Storage via it, but if
// confirmNoteAttachment never runs afterward (tab closed, network drop,
// user abandons the flow), that object sits in storage.objects with no
// note_attachments row pointing at it -- indefinitely, until someone adds a
// periodic sweep (e.g. diff storage.objects under this bucket against
// note_attachments.storage_path and delete anything unmatched past some
// grace period). Not built here; flagging it rather than leaving it an
// undocumented surprise.
// ============================================================================

const DOWNLOAD_URL_EXPIRY_SECONDS = 60;

/**
 * Strips a user-supplied filename down to the character set the storage
 * path convention below can safely embed as its final segment
 * ({organization_id}/{note_id}/{uuid}-{sanitized_filename}). Anything
 * outside [A-Za-z0-9._-] is replaced (most importantly '/', which could
 * otherwise shift the path's folder structure that
 * storage.foldername()-based RLS policies parse structurally -- see that
 * migration's section 5 header comment), repeated separators are
 * collapsed, and the result is truncated to a sane length.
 */
function sanitizeFileName(fileName: string): string {
  const truncated = fileName.trim().slice(-150); // keep the tail (extension survives even for absurdly long names)
  const cleaned = truncated.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_{2,}/g, "_");
  const trimmed = cleaned.replace(/^[._-]+|[._-]+$/g, "");
  return trimmed.length > 0 ? trimmed : "file";
}

export interface CreateUploadUrlResult {
  error: string | null;
  signedUrl?: string;
  token?: string;
  path?: string;
}

/**
 * Step 1 of the upload flow. Validates size/mime from the shared config
 * first (no DB round trip at all for an obviously invalid file), then does
 * an RLS-scoped lookup of the note to learn its organization_id -- a null
 * result (note doesn't exist, OR the caller isn't a member of its
 * organization; RLS returns zero rows either way, not an error) is
 * surfaced as one generic "Note not found.", which is what keeps a
 * non-member from ever learning anything about a note they can't see, let
 * alone getting a storage-RLS-shaped error out of the next step. A soft,
 * app-level attachment-count check runs after that (see
 * MAX_ATTACHMENTS_PER_NOTE's doc comment for why it's not a security
 * boundary), and only then is the storage path built and a signed upload
 * URL minted.
 */
export async function createAttachmentUploadUrl(
  noteId: string,
  fileName: string,
  fileSize: number,
  contentType: string,
): Promise<CreateUploadUrlResult> {
  if (!noteId) return { error: "Missing note id." };
  if (!fileName) return { error: "Missing file name." };

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return { error: "Invalid file size." };
  }
  if (fileSize > MAX_ATTACHMENT_SIZE_BYTES) {
    return { error: `File is too large (max ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024))} MB).` };
  }
  if (!isAllowedAttachmentMimeType(contentType)) {
    return { error: "File type not allowed." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const { data: note, error: noteError } = await supabase
    .from("notes")
    .select("organization_id")
    .eq("id", noteId)
    .maybeSingle();

  if (noteError) return { error: `Could not look up note: ${noteError.message}` };
  if (!note) return { error: "Note not found." };

  // Soft app-level count check -- see MAX_ATTACHMENTS_PER_NOTE's doc comment
  // (lib/note-attachments-config.ts) for why this is not a security
  // boundary and can be raced past under concurrent uploads; still worth
  // doing honestly rather than skipping it because it's imperfect.
  const { count, error: countError } = await supabase
    .from("note_attachments")
    .select("id", { count: "exact", head: true })
    .eq("note_id", noteId);

  if (countError) return { error: `Could not check attachment count: ${countError.message}` };
  if ((count ?? 0) >= MAX_ATTACHMENTS_PER_NOTE) {
    return { error: `This note already has the maximum of ${MAX_ATTACHMENTS_PER_NOTE} attachments.` };
  }

  const path = `${note.organization_id}/${noteId}/${randomUUID()}-${sanitizeFileName(fileName)}`;

  const { data: signed, error: signError } = await supabase.storage
    .from(NOTE_ATTACHMENTS_BUCKET)
    .createSignedUploadUrl(path);

  if (signError || !signed) {
    return { error: `Could not create upload URL: ${signError?.message ?? "unknown error"}` };
  }

  return { error: null, signedUrl: signed.signedUrl, token: signed.token, path: signed.path };
}

export interface ConfirmAttachmentResult {
  error: string | null;
  id?: string;
}

/**
 * Step 3 of the upload flow, called once the browser has confirmed the
 * bytes landed in Storage (step 2, uploadToSignedUrl, happens client-side
 * and never touches this server). organization_id is re-derived here from
 * a FRESH RLS-scoped lookup rather than accepted as an argument -- this
 * action must stand on its own against a directly-forged call, not lean on
 * createAttachmentUploadUrl having already checked it earlier in the same
 * flow. `.select("id").maybeSingle()` after the insert is the same
 * no-op-detection pattern as updateNote/deleteNote in app/actions/notes.ts:
 * an insert RLS silently rejects returns 0 rows and NO error from
 * PostgREST, so checking `error` alone would misreport success.
 */
export async function confirmNoteAttachment(
  noteId: string,
  storagePath: string,
  fileName: string,
  contentType: string,
  sizeBytes: number,
): Promise<ConfirmAttachmentResult> {
  if (!noteId || !storagePath || !fileName) {
    return { error: "Missing required fields." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const { data: note, error: noteError } = await supabase
    .from("notes")
    .select("organization_id")
    .eq("id", noteId)
    .maybeSingle();

  if (noteError) return { error: `Could not look up note: ${noteError.message}` };
  if (!note) return { error: "Note not found." };

  // storagePath comes from the client (it's the path createAttachmentUploadUrl
  // handed back after a successful uploadToSignedUrl) -- organization_id and
  // note_id are independently re-derived/enforced above and by the DB
  // trigger, but nothing else checks storagePath itself against the
  // {organization_id}/{noteId}/ prefix this feature's path convention
  // assumes. Not exploitable for cross-tenant byte access (storage.objects
  // RLS re-derives the org from the REAL path whenever a signed URL is
  // minted), but a forged path here would still corrupt this row's own
  // metadata-integrity guarantee -- reject it up front instead.
  const expectedPrefix = `${note.organization_id}/${noteId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    return { error: "Storage path does not match this note." };
  }

  const { data, error } = await supabase
    .from("note_attachments")
    .insert({
      note_id: noteId,
      organization_id: note.organization_id,
      uploaded_by: user.id,
      storage_path: storagePath,
      file_name: fileName,
      content_type: contentType || null,
      size_bytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    })
    .select("id")
    .maybeSingle();

  if (error) return { error: `Could not save attachment: ${error.message}` };
  if (!data) return { error: "Could not save attachment (no permission)." };

  revalidatePath("/notes");
  return { error: null, id: data.id };
}

export interface DeleteAttachmentResult {
  error: string | null;
}

/**
 * Deletes the DB metadata row FIRST, then best-effort removes the
 * underlying storage object. Deliberately in that order, not the reverse:
 * if storage removal ran first and the metadata delete then failed/was
 * denied, the app would be left with a note_attachments row pointing at
 * bytes that no longer exist -- a broken download link shown to every org
 * member. Doing the DB delete first means the worst case, if the SECOND
 * step (storage removal) fails, is a harmless orphaned blob that nothing in
 * the UI points at anymore -- not a link to nothing.
 */
export async function deleteNoteAttachment(attachmentId: string): Promise<DeleteAttachmentResult> {
  if (!attachmentId) return { error: "Missing attachment id." };

  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("note_attachments")
    .delete()
    .eq("id", attachmentId)
    .select("storage_path")
    .maybeSingle();

  if (error) return { error: `Could not delete attachment: ${error.message}` };
  if (!data) return { error: "Attachment not found, or you don't have permission to delete it." };

  // Best-effort: not fatal if this fails, see doc comment above.
  const { error: storageError } = await supabase.storage.from(NOTE_ATTACHMENTS_BUCKET).remove([data.storage_path]);
  if (storageError) {
    console.error(
      `deleteNoteAttachment: DB row ${attachmentId} deleted, but removing storage object ${data.storage_path} failed: ${storageError.message}`,
    );
  }

  revalidatePath("/notes");
  return { error: null };
}

export interface DownloadUrlResult {
  error: string | null;
  url?: string;
}

/**
 * On-demand signed download URL for one attachment -- deliberately not
 * pre-signed for every attachment on every page render (that would mean
 * minting a Storage-authorizing URL for files nobody ends up downloading).
 * RLS-scoped lookup of storage_path first (null -> generic not-found, same
 * reasoning as createAttachmentUploadUrl above), then a short-lived signed
 * URL for that exact path.
 */
export async function getAttachmentDownloadUrl(attachmentId: string): Promise<DownloadUrlResult> {
  if (!attachmentId) return { error: "Missing attachment id." };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("note_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  if (error) return { error: `Could not look up attachment: ${error.message}` };
  if (!data) return { error: "Attachment not found." };

  const { data: signed, error: signError } = await supabase.storage
    .from(NOTE_ATTACHMENTS_BUCKET)
    .createSignedUrl(data.storage_path, DOWNLOAD_URL_EXPIRY_SECONDS);

  if (signError || !signed) {
    return { error: `Could not create download URL: ${signError?.message ?? "unknown error"}` };
  }

  return { error: null, url: signed.signedUrl };
}
