import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "./supabase/server";
import type { Database } from "./supabase/database.types";

export interface ActiveOrganization {
  id: string;
  name: string;
  slug: string;
  role: string;
}

// The user's "current workspace" for pages that are org-scoped but not
// org-scoped in the URL (this app deliberately keeps flat routes --
// /dashboard, /notes, /pricing -- rather than /org/[slug]/... to avoid a
// large routing refactor, see components/layout/org-switcher.tsx). A plain
// httpOnly cookie holding an organization_id is enough: it's never trusted
// at face value anywhere it's read (see getActiveOrganization below), so a
// tampered/forged value can only ever cause a harmless fallback to "first
// organization by created_at", never leak another organization's data.
export const ACTIVE_ORG_COOKIE = "active_org_id";
const ACTIVE_ORG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

async function loadOrganization(
  supabase: SupabaseClient<Database>,
  organizationId: string,
): Promise<{ id: string; name: string; slug: string }> {
  const { data: org, error } = await supabase
    .from("organizations")
    .select("id, name, slug")
    .eq("id", organizationId)
    .single();

  if (error) {
    throw new Error(`Failed to load organization: ${error.message}`);
  }
  return org;
}

/**
 * Resolves the signed-in user's ACTIVE organization, scoped entirely through
 * the session-bound (anon-key) Supabase client passed in -- every query here
 * is subject to RLS (organization_members_select_same_org / is_org_member),
 * so this can never return another user's organization no matter what
 * userId is passed, short of a bug that lets someone pass another user's id
 * (which callers must not do -- always source userId from
 * `supabase.auth.getUser()` on the same request).
 *
 * Resolution order:
 *   1. `ACTIVE_ORG_COOKIE`, if present AND the user is still actually a
 *      member of that organization (re-checked here via RLS on every call --
 *      never assumed valid just because the cookie exists, since membership
 *      can change, e.g. removed by an owner, after the cookie was set).
 *   2. Fallback: the user's first organization by `created_at` (this was the
 *      ONLY behavior before the org switcher existed, and remains correct
 *      for the common case of a user with exactly one organization). The
 *      cookie is then best-effort corrected to match, so the next call short
 *      circuits straight to branch 1.
 */
export async function getActiveOrganization(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ActiveOrganization | null> {
  const cookieStore = await cookies();
  const cookieOrgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

  if (cookieOrgId) {
    const { data: membership, error: membershipError } = await supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("organization_id", cookieOrgId)
      .eq("user_id", userId)
      .maybeSingle();

    if (membershipError) {
      throw new Error(`Failed to verify active organization membership: ${membershipError.message}`);
    }

    if (membership) {
      const org = await loadOrganization(supabase, membership.organization_id);
      return { id: org.id, name: org.name, slug: org.slug, role: membership.role };
    }
    // Cookie present but stale/forged/no-longer-a-member -- fall through to
    // exactly the same fallback as "no cookie at all" below, and correct the
    // cookie once we know the real answer.
  }

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

  const org = await loadOrganization(supabase, membership.organization_id);

  // Best-effort: keep the cookie consistent with what was just resolved.
  // Writing a cookie is only actually possible from a Server Action / Route
  // Handler; when this runs during a Server Component render (e.g. a page
  // awaiting this function directly), cookies().set() throws, which is
  // deliberately swallowed here -- same tolerance, and the same reason, as
  // lib/supabase/server.ts's own setAll doc comment.
  try {
    cookieStore.set(ACTIVE_ORG_COOKIE, org.id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: ACTIVE_ORG_COOKIE_MAX_AGE,
    });
  } catch {
    // Server Component render -- see comment above.
  }

  return { id: org.id, name: org.name, slug: org.slug, role: membership.role };
}

/**
 * Every organization the user belongs to, for the org switcher UI
 * (components/layout/org-switcher.tsx). Same RLS-scoping guarantee as
 * getActiveOrganization above -- returns exactly what
 * organization_members_select_same_org lets this session see, no more.
 * Sorted by name (not created_at) since this drives a picker menu, not a
 * "which one is default" decision.
 */
export async function getUserOrganizations(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ActiveOrganization[]> {
  const { data: memberships, error: membershipError } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", userId);

  if (membershipError) {
    throw new Error(`Failed to load organization memberships: ${membershipError.message}`);
  }
  if (!memberships || memberships.length === 0) {
    return [];
  }

  const { data: orgs, error: orgsError } = await supabase
    .from("organizations")
    .select("id, name, slug")
    .in(
      "id",
      memberships.map((m) => m.organization_id),
    );

  if (orgsError) {
    throw new Error(`Failed to load organizations: ${orgsError.message}`);
  }

  const roleByOrgId = new Map(memberships.map((m) => [m.organization_id, m.role]));
  return (orgs ?? [])
    .map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: roleByOrgId.get(org.id) ?? "member",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Verifies the current signed-in user is an OWNER of `organizationId` before
 * doing anything owner-only (billing, invites). Originally private to
 * app/actions/billing.ts; hoisted here so app/actions/invites.ts can reuse
 * the exact same check instead of a second copy that could drift.
 *
 * IMPORTANT: this does not just check the shape of the client-supplied
 * organizationId -- the SELECT itself is RLS-gated (is_org_member /
 * is_org_owner), so a user who isn't actually a member of that org gets zero
 * rows back no matter what id they pass in. We never trust the client to
 * tell us who they are; we always look it up against their own session.
 */
export async function requireOrgOwner(organizationId: string) {
  if (!organizationId) {
    throw new Error("Missing organizationId.");
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership, error } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify organization membership: ${error.message}`);
  }

  if (!membership || membership.role !== "owner") {
    throw new Error("Only an organization owner can do this.");
  }

  return { supabase, user, organizationId };
}
