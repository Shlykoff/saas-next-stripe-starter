"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ACTIVE_ORG_COOKIE } from "@/lib/org";

export interface SwitchOrganizationState {
  error: string | null;
}

/**
 * Server Action backing the org switcher (components/layout/org-switcher.tsx).
 * Invoked directly from a client event handler (not through a <form>), which
 * is a fully supported way to call a "use server" function -- see the
 * component for why a form per menu item would be awkward here.
 *
 * Re-verifies membership itself rather than trusting that the dropdown only
 * ever lists organizations the user actually belongs to: the dropdown's
 * options come from lib/org.ts's getUserOrganizations (already RLS-scoped),
 * but a client-supplied organizationId must never be trusted at face value
 * regardless of where the UI sourced it from -- same posture as every other
 * server action in this app that takes an organizationId from a form.
 */
export async function switchOrganization(organizationId: string): Promise<SwitchOrganizationState> {
  if (!organizationId) {
    return { error: "Missing organization." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { data: membership, error } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return { error: `Failed to verify organization membership: ${error.message}` };
  }
  if (!membership) {
    // Not actually a member of this organization (forged/stale id) -- do
    // nothing rather than switch to an organization the user can't access.
    return { error: "You are not a member of that organization." };
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, organizationId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });

  // Every org-scoped page (dashboard, notes, pricing, the new members page)
  // reads the active organization via lib/org.ts's getActiveOrganization,
  // which itself reads this cookie -- revalidating the whole tree is what
  // makes the switch take effect on the very next render instead of only
  // after a manual refresh.
  revalidatePath("/", "layout");

  return { error: null };
}
