import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";

// MVP scope: a user belongs to at most one organization in practice (the
// onboarding flow in app/onboarding/page.tsx only ever creates one, and
// there is no invite flow yet per docs/spec.md), so there is no org
// switcher UI. The schema itself does allow a user to be a member of
// several organizations (organization_members has no uniqueness constraint
// across users), so if that ever changes, "first membership by created_at"
// below is the one place that needs to grow into a real switcher.
export interface ActiveOrganization {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * Resolves the signed-in user's organization, scoped entirely through the
 * session-bound (anon-key) Supabase client passed in -- every query here is
 * subject to RLS (organization_members_select_same_org / is_org_member), so
 * this can never return another user's organization no matter what userId
 * is passed, short of a bug that lets someone pass another user's id (which
 * callers must not do -- always source userId from
 * `supabase.auth.getUser()` on the same request).
 */
export async function getActiveOrganization(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ActiveOrganization | null> {
  const { data: membership, error: membershipError } = await supabase
    .from("organization_members")
    .select("organization_id, role, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membershipError) {
    throw new Error(`Failed to load organization membership: ${membershipError.message}`);
  }
  if (!membership) {
    return null;
  }

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name, slug")
    .eq("id", membership.organization_id)
    .single();

  if (orgError) {
    throw new Error(`Failed to load organization: ${orgError.message}`);
  }

  return { id: org.id, name: org.name, slug: org.slug, role: membership.role };
}
