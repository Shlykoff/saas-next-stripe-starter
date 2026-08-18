"use client";

import { useState, useTransition } from "react";
import { changeMemberRole } from "@/app/actions/org";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Inline role editor next to a teammate's row on app/dashboard/members/page.tsx
 * (owner-only, never shown for the owner's own row -- see that page's
 * canOwnerRemove comment for why self-service role changes aren't offered
 * here). Calls changeMemberRole (app/actions/org.ts) directly via a
 * transition rather than through a <form>, same pattern as
 * components/layout/org-switcher.tsx's switchOrganization call -- there's
 * no natural "submit" moment for a role dropdown the way there is for a
 * text field, so selecting a new value IS the submission.
 *
 * Optimistic: the select flips to the new value immediately, then reverts
 * if the server rejects it (e.g. demoting the sole owner -- see
 * changeMemberRole's own doc comment on trg_prevent_last_owner_change).
 * Reverting rather than leaving the select on a value the database didn't
 * actually accept is what keeps this control honest about the real state.
 */
export function ChangeRoleSelect({
  memberId,
  currentRole,
  ariaLabel,
}: {
  memberId: string;
  currentRole: string;
  ariaLabel: string;
}) {
  const [role, setRole] = useState(currentRole);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(value: unknown) {
    const newRole = String(value);
    if (newRole === role) return;

    const previousRole = role;
    setRole(newRole);
    setError(null);

    startTransition(async () => {
      const formData = new FormData();
      formData.set("memberId", memberId);
      formData.set("role", newRole);
      const result = await changeMemberRole({ error: null }, formData);
      if (result.error) {
        setRole(previousRole);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Select value={role} onValueChange={handleChange} disabled={isPending}>
        <SelectTrigger className="h-8 w-28" aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="member">Member</SelectItem>
          <SelectItem value="owner">Owner</SelectItem>
        </SelectContent>
      </Select>
      {error && (
        <span className="max-w-48 text-right text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
