"use client";

import { useTransition } from "react";
import { ChevronsUpDown } from "lucide-react";
import { switchOrganization } from "@/app/actions/org";
import type { ActiveOrganization } from "@/lib/org";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Workspace switcher shown in the site header, next to the app logo. This
 * app deliberately keeps flat routes (/dashboard, /notes, /pricing) rather
 * than an /org/[slug]/... prefix (see lib/org.ts's ACTIVE_ORG_COOKIE doc
 * comment), so "which organization am I acting as" lives entirely in a
 * cookie + this menu, not the URL.
 *
 * Exactly one organization: render its name as plain text -- a dropdown with
 * a single, unchangeable option is decoration, not a control, so it isn't
 * one (per the nextjs-frontend brief).
 */
export function OrgSwitcher({
  organizations,
  activeOrganizationId,
}: {
  organizations: Pick<ActiveOrganization, "id" | "name">[];
  activeOrganizationId: string | null;
}) {
  const [isPending, startTransition] = useTransition();
  const active = organizations.find((org) => org.id === activeOrganizationId) ?? organizations[0];

  if (!active) {
    return null;
  }

  if (organizations.length === 1) {
    return (
      <span className="max-w-32 truncate px-1 text-sm font-medium text-muted-foreground sm:max-w-48">
        {active.name}
      </span>
    );
  }

  function handleSelect(value: unknown) {
    const organizationId = String(value);
    if (organizationId === active?.id) return;
    startTransition(async () => {
      const result = await switchOrganization(organizationId);
      if (result.error) {
        // Only reachable if the client-supplied id is stale/forged (see
        // switchOrganization's own comment) -- there's no dedicated error UI
        // for a menu click, so this is a last-resort, non-blocking signal
        // rather than a thrown error that would crash the header.
        console.error("Failed to switch organization:", result.error);
      }
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" disabled={isPending} />}
      >
        <span className="max-w-28 truncate sm:max-w-40">{active.name}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={active.id} onValueChange={handleSelect}>
          {organizations.map((org) => (
            <DropdownMenuRadioItem key={org.id} value={org.id}>
              {org.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
