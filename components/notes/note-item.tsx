"use client";

import { useActionState, useState, useTransition } from "react";
import { deleteNote, updateNote, type NoteActionState } from "@/app/actions/notes";
import { MAX_NOTE_TITLE_LENGTH, MAX_NOTE_BODY_LENGTH } from "@/lib/note-validation";
import type { NoteRow } from "@/lib/notes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { NoteAttachmentsList } from "@/components/notes/note-attachments-list";
import { AttachmentUpload } from "@/components/notes/attachment-upload";

const initialState: NoteActionState = { error: null };

export function NoteItem({
  note,
  canManage,
  isOwnNote,
  currentUserId,
  isOrgOwner,
}: {
  note: NoteRow;
  /** True if the signed-in user is the author OR the org owner -- mirrors
   *  RLS policies "notes_update_author_or_owner" / "notes_delete_author_or_owner".
   *  This only controls whether Edit/Delete render; the real enforcement is
   *  server-side in app/actions/notes.ts (RLS), so a stale/wrong value here
   *  can only ever hide a control the server would refuse anyway, never
   *  expose one that actually works. */
  canManage: boolean;
  isOwnNote: boolean;
  /** Signed-in user's id -- passed down (rather than read inside
   *  NoteAttachmentsList) so this component tree never needs its own
   *  supabase.auth.getUser() call; app/notes/page.tsx already has it. */
  currentUserId: string;
  /** True if the signed-in user is this ORGANIZATION's owner -- NOT the
   *  same thing as `canManage` above, which is about the NOTE's author.
   *  Attachment deletion is gated to the attachment's uploader OR the org
   *  owner (RLS policy "note_attachments_delete_uploader_or_owner"), a
   *  different pairing than who can edit the note's own title/body -- see
   *  components/notes/note-attachments-list.tsx's doc comment. */
  isOrgOwner: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [deleteState, deleteAction, isDeleting] = useActionState(deleteNote, initialState);

  if (isEditing) {
    return (
      <NoteEditForm note={note} onCancel={() => setIsEditing(false)} onSaved={() => setIsEditing(false)} />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">{note.title}</CardTitle>
            <CardDescription>
              {isOwnNote ? "You" : "Teammate"} &middot;{" "}
              {new Date(note.created_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </CardDescription>
          </div>
          {canManage && (
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
              <form
                action={deleteAction}
                onSubmit={(event) => {
                  if (!window.confirm(`Delete "${note.title}"?`)) {
                    event.preventDefault();
                  }
                }}
              >
                <input type="hidden" name="noteId" value={note.id} />
                <Button type="submit" variant="ghost" size="sm" disabled={isDeleting}>
                  {isDeleting ? "Deleting..." : "Delete"}
                </Button>
              </form>
            </div>
          )}
        </div>
      </CardHeader>
      {note.body && (
        <CardContent>
          <p className="whitespace-pre-wrap text-sm text-foreground">{note.body}</p>
        </CardContent>
      )}
      <CardContent className="flex flex-col gap-3 border-t pt-4">
        <NoteAttachmentsList
          attachments={note.note_attachments}
          currentUserId={currentUserId}
          isOrgOwner={isOrgOwner}
        />
        <AttachmentUpload noteId={note.id} />
      </CardContent>
      {deleteState.error && (
        <CardFooter>
          <Alert variant="destructive" role="alert" className="w-full">
            <AlertDescription>{deleteState.error}</AlertDescription>
          </Alert>
        </CardFooter>
      )}
    </Card>
  );
}

// Deliberately NOT built on useActionState + a useEffect watching its
// `.success` flag to flip the parent back out of edit mode: that pattern
// (a) triggers the "no setState in a useEffect" lint rule (cascading
// renders), and (b) has a real correctness bug -- useActionState's state
// persists across submissions, so a stale `success: true` from a PREVIOUS
// save would immediately auto-close the form again the next time the user
// re-enters edit mode, before they'd even touched Save. Driving the submit
// manually through useTransition and awaiting the action's result directly
// in the event handler avoids both: "close on success" and "show the
// error" are just normal state updates made after an awaited async call
// inside a genuine user-event handler, not synchronized via an effect.
function NoteEditForm({
  note,
  onCancel,
  onSaved,
}: {
  note: NoteRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await updateNote({ error: null }, formData);
      if (result.error) {
        setError(result.error);
      } else {
        onSaved();
      }
    });
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input type="hidden" name="noteId" value={note.id} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`title-${note.id}`}>Title</Label>
            <Input
              id={`title-${note.id}`}
              name="title"
              required
              maxLength={MAX_NOTE_TITLE_LENGTH}
              defaultValue={note.title}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`body-${note.id}`}>Body</Label>
            <Textarea
              id={`body-${note.id}`}
              name="body"
              maxLength={MAX_NOTE_BODY_LENGTH}
              defaultValue={note.body}
              rows={3}
            />
          </div>

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Saving..." : "Save"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
