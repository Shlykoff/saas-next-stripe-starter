"use client";

import { useState, useTransition } from "react";
import { createAttachmentUploadUrl, confirmNoteAttachment } from "@/app/actions/note-attachments";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  NOTE_ATTACHMENTS_BUCKET,
  isAllowedAttachmentMimeType,
} from "@/lib/note-attachments-config";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Upload flow for note attachments -- three round trips, only the middle
 * one goes to Supabase Storage directly rather than through this Next.js
 * app (see app/actions/note-attachments.ts's header comment for the full
 * architecture writeup):
 *
 *   1. createAttachmentUploadUrl (Server Action) -- validates and mints a
 *      short-lived signed upload URL/token scoped to one exact storage
 *      path.
 *   2. uploadToSignedUrl (direct browser -> Supabase Storage, via the
 *      browser Supabase client -- same client-construction approach as
 *      components/notes/notes-realtime.tsx's createBrowserSupabaseClient()
 *      call) -- the actual bytes never pass through a Vercel serverless
 *      function, which caps request bodies at ~4.5MB; a multi-MB file sent
 *      through a Server Action instead would hit that ceiling.
 *   3. confirmNoteAttachment (Server Action) -- records the DB metadata row
 *      now that the bytes are confirmed to exist in Storage. This is the
 *      step that actually calls revalidatePath("/notes"), so the new
 *      attachment shows up without an explicit router.refresh() here --
 *      same "Server Action mutation auto-refreshes the route" mechanism
 *      NoteEditForm (components/notes/note-item.tsx) already relies on.
 *
 * Deliberately NOT built on useActionState: this is a multi-step async flow
 * (three awaited calls, only one of which is a plain Server Action form
 * submission), and useActionState's persisted state would stale-trigger on
 * re-entry the same way NoteEditForm's own doc comment explains for the
 * note-edit form -- driving it manually through useTransition + a plain
 * async handler avoids that class of bug entirely.
 */
export function AttachmentUpload({ noteId }: { noteId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file again after an error
    if (!file) return;

    setError(null);

    // Client-side pre-check -- UX only, saves an upload round trip for an
    // obviously invalid file. The REAL enforcement is server-side, in
    // createAttachmentUploadUrl's own size/mime check plus the bucket's own
    // file_size_limit/allowed_mime_types (Storage rejects it independently
    // even if this check were bypassed entirely).
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      setError(`File is too large (max ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024))} MB).`);
      return;
    }
    if (!isAllowedAttachmentMimeType(file.type)) {
      setError("File type not allowed.");
      return;
    }

    startTransition(async () => {
      const uploadUrlResult = await createAttachmentUploadUrl(noteId, file.name, file.size, file.type);
      if (uploadUrlResult.error || !uploadUrlResult.signedUrl || !uploadUrlResult.token || !uploadUrlResult.path) {
        setError(uploadUrlResult.error ?? "Could not start upload.");
        return;
      }

      const supabase = createBrowserSupabaseClient();
      const { error: uploadError } = await supabase.storage
        .from(NOTE_ATTACHMENTS_BUCKET)
        .uploadToSignedUrl(uploadUrlResult.path, uploadUrlResult.token, file, {
          contentType: file.type,
        });

      if (uploadError) {
        setError(`Upload failed: ${uploadError.message}`);
        return;
      }

      const confirmResult = await confirmNoteAttachment(noteId, uploadUrlResult.path, file.name, file.type, file.size);
      if (confirmResult.error) {
        setError(confirmResult.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`attachment-${noteId}`}>Attach a file</Label>
      <input
        id={`attachment-${noteId}`}
        type="file"
        accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(",")}
        disabled={isPending}
        onChange={handleChange}
        className="text-sm text-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent disabled:opacity-50"
      />
      {isPending && (
        <p className="text-xs text-muted-foreground" role="status">
          Uploading...
        </p>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
