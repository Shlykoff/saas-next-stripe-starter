"use client";

import { useState, useTransition } from "react";
import { deleteNoteAttachment, getAttachmentDownloadUrl } from "@/app/actions/note-attachments";
import type { NoteAttachmentRow } from "@/lib/notes";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

function formatBytes(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lists one note's attachments -- file name, human-readable size, an
 * on-demand Download button, and a Delete button gated to
 * `uploaded_by === currentUserId OR isOrgOwner`. Mirrors RLS policy
 * "note_attachments_delete_uploader_or_owner"
 * (supabase/migrations/20260818222947_add_note_attachments.sql) for what
 * this component SHOWS; the real enforcement is that RLS policy itself,
 * exercised server-side by deleteNoteAttachment
 * (app/actions/note-attachments.ts) -- a stale/wrong value here can only
 * ever hide a control the server would refuse anyway, never expose one that
 * actually works. Note isOrgOwner is NOT the same thing as note-item.tsx's
 * own `canManage`/`isOwnNote` (those are about the NOTE's author vs. the
 * org owner; this is about who UPLOADED the attachment vs. the org owner --
 * two different people can hold either role on the very same note).
 */
export function NoteAttachmentsList({
  attachments,
  currentUserId,
  isOrgOwner,
}: {
  attachments: NoteAttachmentRow[];
  currentUserId: string;
  isOrgOwner: boolean;
}) {
  if (attachments.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2 text-sm">
      {attachments.map((attachment) => (
        <AttachmentRow
          key={attachment.id}
          attachment={attachment}
          canDelete={attachment.uploaded_by === currentUserId || isOrgOwner}
        />
      ))}
    </ul>
  );
}

function AttachmentRow({ attachment, canDelete }: { attachment: NoteAttachmentRow; canDelete: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [isDownloading, startDownloadTransition] = useTransition();
  const [isDeleting, startDeleteTransition] = useTransition();
  const sizeLabel = formatBytes(attachment.size_bytes);

  function handleDownload() {
    setError(null);
    startDownloadTransition(async () => {
      const result = await getAttachmentDownloadUrl(attachment.id);
      if (result.error || !result.url) {
        setError(result.error ?? "Could not create download link.");
        return;
      }
      // getAttachmentDownloadUrl's signed URL already carries
      // Content-Disposition: attachment (app/actions/note-attachments.ts
      // passes `{ download: file_name }` to createSignedUrl) -- the browser
      // treats it as a download rather than a navigation regardless of how
      // it's reached, so no new tab/window is needed at all (an earlier
      // version of this handler opened one; that's gone now). A temporary,
      // never-attached-to-anything-visible <a> click is the standard way to
      // trigger that download without moving the current page away from
      // itself: the click resolves to a download (per the response header
      // above), the browser's native save dialog/prompt appears over the
      // current page, and this page never navigates or blanks.
      const link = document.createElement("a");
      link.href = result.url;
      link.rel = "noopener";
      link.click();
    });
  }

  function handleDelete() {
    if (!window.confirm(`Delete "${attachment.file_name}"?`)) return;
    setError(null);
    startDeleteTransition(async () => {
      const result = await deleteNoteAttachment(attachment.id);
      if (result.error) {
        setError(result.error);
      }
    });
  }

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate" title={attachment.file_name}>
          {attachment.file_name}
          {sizeLabel && <span className="ml-1.5 text-xs text-muted-foreground">({sizeLabel})</span>}
        </span>
        <div className="flex shrink-0 gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={handleDownload} disabled={isDownloading}>
            {isDownloading ? "..." : "Download"}
          </Button>
          {canDelete && (
            <Button type="button" variant="ghost" size="sm" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "..." : "Delete"}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}
