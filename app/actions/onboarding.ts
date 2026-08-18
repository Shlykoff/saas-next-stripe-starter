"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export interface OnboardingActionState {
  error: string | null;
}

// Must stay in sync with the `slug` check constraint in
// supabase/migrations/20260817171827_init_core_schema.sql:
//   slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Server Action backing the "create your organization" form
 * (app/onboarding/page.tsx). Relies entirely on the DB side to do the real
 * work: RLS policy "organizations_insert_authenticated" allows any signed-in
 * user to INSERT a row here, and the `trg_new_organization_owner` trigger
 * (see migration, section 6) makes the inserting user its owner
 * automatically -- this action does not, and must not, insert into
 * organization_members itself; the only privilege-escalation-safe way to
 * become an owner is through that trigger.
 */
export async function createOrganization(
  _prevState: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const rawSlug = String(formData.get("slug") ?? "").trim();

  if (name.length === 0) {
    return { error: "Organization name is required." };
  }
  if (name.length > 100) {
    return { error: "Organization name is too long (max 100 characters)." };
  }

  const slug = slugify(rawSlug.length > 0 ? rawSlug : name);
  if (!SLUG_RE.test(slug)) {
    return {
      error:
        "Workspace URL must be lowercase letters, numbers, and hyphens only (e.g. \"acme-corp\").",
    };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { error } = await supabase.from("organizations").insert({ name, slug });

  if (error) {
    // Postgres unique_violation on organizations.slug.
    if (error.code === "23505") {
      return { error: `The workspace URL "${slug}" is already taken. Try a different one.` };
    }
    return { error: `Could not create organization: ${error.message}` };
  }

  redirect("/dashboard");
}
