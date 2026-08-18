"use client";

import { useActionState, useEffect, useRef } from "react";
import { createInvite, type InviteActionState } from "@/app/actions/invites";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const initialState: InviteActionState = { error: null };

export function InviteMemberForm({ organizationId }: { organizationId: string }) {
  const [state, formAction, isPending] = useActionState(createInvite, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // Server Actions don't reset an uncontrolled form on success the way a
  // normal navigation would -- this component stays mounted (only the
  // invite list below it re-fetches via revalidatePath), so the inputs are
  // cleared manually once a submission actually succeeded. Same pattern as
  // components/notes/create-note-form.tsx.
  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end"
    >
      <input type="hidden" name="organizationId" value={organizationId} />

      <div className="flex flex-1 flex-col gap-1.5 sm:min-w-48">
        <Label htmlFor="invite-email">Email</Label>
        <Input
          id="invite-email"
          name="email"
          type="email"
          required
          autoComplete="off"
          placeholder="teammate@example.com"
          aria-invalid={state.error ? true : undefined}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-role">Role</Label>
        <Select name="role" defaultValue="member">
          <SelectTrigger id="invite-role" className="w-full sm:w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="owner">Owner</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button type="submit" disabled={isPending}>
        {isPending ? "Sending..." : "Send invite"}
      </Button>

      {state.error && (
        <Alert variant="destructive" role="alert" className="w-full">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
