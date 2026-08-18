// Pure, framework-free config for note attachments -- deliberately no
// "server-only" import and no imports at all, mirroring
// lib/note-query-params.ts's rationale: app/actions/note-attachments.ts
// needs these constants server-side, but components/notes/attachment-upload.tsx
// (a "use client" component) ALSO needs them for its client-side pre-check
// (UX only, not the real security boundary -- see that action file's doc
// comments for the actual enforcement) before spending an upload round trip
// on a file that's obviously too big or the wrong type. If this lived in
// lib/notes.ts (which starts with `import "server-only"`), importing it
// from a client component would be a hard Next.js build error.

/** Bucket id, shared by app/actions/note-attachments.ts (server) and components/notes/attachment-upload.tsx (client uploadToSignedUrl call) so it's declared once. */
export const NOTE_ATTACHMENTS_BUCKET = "note-attachments";

/**
 * MUST equal the note-attachments bucket's `file_size_limit` in
 * supabase/migrations/20260818222947_add_note_attachments.sql (10485760 =
 * 10 MiB). Flagged explicitly in that migration's own header comment --
 * kept here as the single TS-side source of truth so the client can reject
 * an oversized file before spending an upload round trip, instead of only
 * discovering the limit from a Storage API error after the bytes are
 * already sent (or worse, after they've already been uploaded). If the
 * DB-side limit ever changes, this constant must change with it -- nothing
 * enforces the two stay in sync automatically.
 */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Soft, application-level cap on attachments per note. NOT a security
 * boundary and NOT enforced by any DB constraint -- the migration
 * deliberately has no count-limiting trigger/check on note_attachments (see
 * its own comments), so this exists purely to stop one note's attachment
 * list from growing unbounded in the UI / the Storage bill. Enforced only
 * in createAttachmentUploadUrl (app/actions/note-attachments.ts) via a
 * best-effort count check that a determined attacker with otherwise-valid
 * RLS access could still race past (TOCTOU between the count check and the
 * eventual insert) -- acceptable here because exceeding it by a row or two
 * under a race is a UX nit, not a security incident.
 */
export const MAX_ATTACHMENTS_PER_NOTE = 10;

/**
 * MUST exactly match the note-attachments bucket's `allowed_mime_types` in
 * supabase/migrations/20260818222947_add_note_attachments.sql. Deliberately
 * excludes image/svg+xml, text/html, and application/xhtml+xml -- see that
 * migration's header comment for the stored-XSS reasoning (an SVG/HTML file
 * served back same-tab from a signed URL can execute script in the origin
 * serving it). Don't add those back here without also solving that.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
] as const;

/** True if `contentType` is exactly one of ALLOWED_ATTACHMENT_MIME_TYPES (no wildcard/prefix matching). */
export function isAllowedAttachmentMimeType(contentType: string): boolean {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(contentType);
}
