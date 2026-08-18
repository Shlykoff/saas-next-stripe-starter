"use client";

import { useActionState } from "react";
import { revokeInvite, type InviteActionState } from "@/app/actions/invites";
import { Button } from "@/components/ui/button";

const initialState: InviteActionState = { error: null };

export function RevokeInviteButton({ inviteId }: { inviteId: string }) {
  const [state, formAction, isPending] = useActionState(revokeInvite, initialState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="inviteId" value={inviteId} />
      <Button type="submit" variant="ghost" size="sm" disabled={isPending}>
        {isPending ? "Revoking..." : "Revoke"}
      </Button>
      {state.error && (
        <span className="text-xs text-destructive" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
