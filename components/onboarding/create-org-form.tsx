"use client";

import { useActionState, useState } from "react";
import { createOrganization, type OnboardingActionState } from "@/app/actions/onboarding";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

const initialState: OnboardingActionState = { error: null };

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CreateOrgForm() {
  const [state, formAction, isPending] = useActionState(createOrganization, initialState);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouchedByUser, setSlugTouchedByUser] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Organization name</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => {
            const value = e.target.value;
            setName(value);
            if (!slugTouchedByUser) {
              setSlug(slugify(value));
            }
          }}
          placeholder="Acme Inc."
          aria-invalid={state.error ? true : undefined}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slug">Workspace slug</Label>
        <Input
          id="slug"
          name="slug"
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          title="Lowercase letters, numbers, and hyphens only."
          value={slug}
          onChange={(e) => {
            setSlugTouchedByUser(true);
            setSlug(slugify(e.target.value));
          }}
          placeholder="acme-inc"
          aria-invalid={state.error ? true : undefined}
        />
        <p className="text-xs text-muted-foreground">
          Lowercase letters, numbers, and hyphens only. Used as your workspace&apos;s unique identifier.
        </p>
      </div>

      {state.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "Creating workspace..." : "Create workspace"}
      </Button>
    </form>
  );
}
