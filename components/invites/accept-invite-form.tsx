"use client";

import { useActionState } from "react";
import { acceptInvite, type AcceptInviteActionState } from "@/app/actions/invites";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

const initialState: AcceptInviteActionState = { error: null };

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState(acceptInvite, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      {state.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? "Joining..." : "Accept invite"}
      </Button>
    </form>
  );
}
