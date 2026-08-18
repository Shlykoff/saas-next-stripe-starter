"use client";

import { useActionState } from "react";
import { removeMember, type RemoveMemberActionState } from "@/app/actions/org";
import { Button } from "@/components/ui/button";

const initialState: RemoveMemberActionState = { error: null };

/**
 * Backs both the owner's "Remove" button (next to a teammate) and a
 * member's own "Leave organization" button on app/dashboard/members/page.tsx
 * -- both are the same removeMember Server Action underneath (see its doc
 * comment in app/actions/org.ts for why one action covers both), so this is
 * one component with a `variant`-driven label rather than two near-duplicate
 * ones.
 *
 * Confirms before submitting, unlike RevokeInviteButton (revoking an
 * un-accepted invite is cheap to undo -- just re-invite) but consistent
 * with NoteItem's delete button: removing a person from an organization (or
 * leaving one) is immediate and, for "remove", not something the removed
 * person can undo themselves.
 */
export function RemoveMemberButton({
  memberId,
  confirmMessage,
  ariaLabel,
  variant = "remove",
}: {
  memberId: string;
  confirmMessage: string;
  /** Screen-reader label -- "Remove" / "Leave" alone doesn't say who/what
   *  without relying on the button's visual position next to the row. */
  ariaLabel: string;
  /** "remove" = owner removing a teammate; "leave" = removing yourself. */
  variant?: "remove" | "leave";
}) {
  const [state, formAction, isPending] = useActionState(removeMember, initialState);

  const label = variant === "leave" ? "Leave" : "Remove";
  const pendingLabel = variant === "leave" ? "Leaving..." : "Removing...";

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="memberId" value={memberId} />
      <Button
        type="submit"
        variant={variant === "leave" ? "outline" : "destructive"}
        size="sm"
        disabled={isPending}
        aria-label={isPending ? undefined : ariaLabel}
      >
        {isPending ? pendingLabel : label}
      </Button>
      {state.error && (
        <span className="text-xs text-destructive" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
