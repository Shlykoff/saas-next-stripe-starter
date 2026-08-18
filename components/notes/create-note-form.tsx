"use client";

import { useActionState, useEffect, useRef } from "react";
import { createNote, type NoteActionState } from "@/app/actions/notes";
import { MAX_NOTE_TITLE_LENGTH, MAX_NOTE_BODY_LENGTH } from "@/lib/note-validation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

const initialState: NoteActionState = { error: null };

export function CreateNoteForm({ organizationId }: { organizationId: string }) {
  const [state, formAction, isPending] = useActionState(createNote, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // Server Actions don't reset an uncontrolled form on success the way a
  // normal navigation would -- this component stays mounted (only the note
  // list below it re-fetches via revalidatePath), so we clear the inputs
  // ourselves once a submission actually succeeded.
  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New note</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="organizationId" value={organizationId} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              name="title"
              required
              maxLength={MAX_NOTE_TITLE_LENGTH}
              placeholder="Note title"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="body">Body</Label>
            <Textarea
              id="body"
              name="body"
              maxLength={MAX_NOTE_BODY_LENGTH}
              placeholder="Write something..."
              rows={3}
            />
          </div>

          {state.error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={isPending} className="w-fit">
            {isPending ? "Adding..." : "Add note"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
