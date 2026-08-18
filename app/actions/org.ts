"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { ACTIVE_ORG_COOKIE } from "@/lib/org";
import { resend, INVITE_EMAIL_FROM } from "@/lib/resend";
import { renderMemberRemovedEmail } from "@/lib/emails/member-removed-email";

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

export interface RemoveMemberActionState {
  error: string | null;
  success?: boolean;
}

/**
 * Server Action backing the "Remove" / "Leave organization" button on
 * app/dashboard/members/page.tsx (components/members/remove-member-button.tsx).
 * One action covers both cases -- removing a teammate and leaving
 * yourself -- because they're the exact same DELETE, and RLS policy
 * "organization_members_delete_owner_or_self" (supabase/migrations/
 * 20260817171827_init_core_schema.sql) already authorizes both under one
 * rule: is_org_owner(organization_id) OR user_id = auth.uid(). This action
 * does not re-check role/ownership itself before attempting the DELETE --
 * same posture as revokeInvite/deleteNote in this app (see their doc
 * comments) -- authorization is entirely RLS's job.
 *
 * Takes the organization_members row's own `id` (not organizationId+userId)
 * -- same shape as deleteNote(noteId) in app/actions/notes.ts -- because
 * that's all a DELETE ... WHERE id = $1 needs; RLS's USING clause evaluates
 * against the target row's actual organization_id/user_id columns
 * regardless of what the WHERE clause filtered on, so there's no
 * authorization gap from omitting them here.
 *
 * `.select()` is chained onto the delete so a genuine "no such member / not
 * your org / not allowed" can be told apart from a real success: RLS
 * silently filtering a DELETE to zero matching rows returns 0 rows and NO
 * error from PostgREST (same reasoning as updateNote/deleteNote/revokeInvite
 * in this app) -- checking `error` alone would report success for a member
 * removal that never actually happened, e.g. a non-owner member trying to
 * remove someone else.
 */
export async function removeMember(
  _prevState: RemoveMemberActionState,
  formData: FormData,
): Promise<RemoveMemberActionState> {
  const memberId = String(formData.get("memberId") ?? "");
  if (!memberId) {
    return { error: "Missing member id." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { data, error } = await supabase
    .from("organization_members")
    .delete()
    .eq("id", memberId)
    .select("id, user_id, organization_id")
    .maybeSingle();

  if (error) {
    // trg_prevent_last_owner_change (supabase/migrations/
    // 20260817171827_init_core_schema.sql) raises a plain Postgres
    // exception ("Cannot remove the last owner of an organization") rather
    // than something PostgREST folds into "0 rows returned" -- so a sole
    // owner trying to remove themselves (or, in principle, another owner
    // somehow removing the last remaining owner) lands here, not in the
    // `!data` branch below. The trigger's message is already written for a
    // human; surfaced close to verbatim rather than the raw
    // Postgres-error-wrapped form other branches in this file use, plus a
    // concrete next step, since "just an error" leaves the owner stuck with
    // no way forward.
    if (error.message.includes("Cannot remove the last owner")) {
      return {
        error:
          "You're the only owner of this organization, so you can't remove yourself. " +
          "Promote another member to owner first, or delete the organization instead.",
      };
    }
    return { error: `Could not remove member: ${error.message}` };
  }
  if (!data) {
    return { error: "Member not found, or you don't have permission to remove them." };
  }

  if (data.user_id === user.id) {
    // Self-removal ("leave organization"): the active-org cookie may still
    // point at the organization the user just left, and every org-scoped
    // page (getActiveOrganization, lib/org.ts) re-verifies membership on
    // every read, so leaving the stale cookie in place would just make the
    // very next page load re-derive "not a member anymore" the hard way.
    // Clearing it here and redirecting through /dashboard lets
    // getActiveOrganization's own fallback (first remaining organization by
    // created_at, or none) resolve cleanly on the next render instead.
    const cookieStore = await cookies();
    cookieStore.delete(ACTIVE_ORG_COOKIE);
    redirect("/dashboard");
  }

  // Owner removed someone else: best-effort notify the removed member by
  // email, mirroring createInvite's posture in app/actions/invites.ts --
  // the removal itself already happened and is never rolled back for a
  // notification failure (there's no undo for either operation, and the
  // owner has no reason to retry the removal just because an email bounced).
  // organization_members has no email column (see the members page's own
  // comment on the same tradeoff), and the DELETE already removed this
  // person's membership row, so their email has to come from auth.users via
  // service_role -- the session client can no longer reach it once the
  // membership (and therefore the RLS-scoped path to it) is gone. The org
  // name lookup uses the session client instead: the current user (the
  // owner) is still a member of that org, so RLS already allows it without
  // needing service_role for this half.
  const serviceClient = createServiceRoleClient();
  const [{ data: removedUser }, { data: org }] = await Promise.all([
    serviceClient.auth.admin.getUserById(data.user_id),
    supabase.from("organizations").select("name").eq("id", data.organization_id).single(),
  ]);

  if (removedUser.user?.email && org?.name) {
    try {
      await resend.emails.send({
        from: INVITE_EMAIL_FROM,
        to: removedUser.user.email,
        subject: `You were removed from ${org.name}`,
        html: renderMemberRemovedEmail({ organizationName: org.name }),
      });
    } catch (sendError) {
      // Swallowed, not surfaced as an action error: the removal itself
      // succeeded, and re-showing this form with an "error" for a
      // notification-only failure would read as if the removal failed,
      // which it didn't. Logged server-side so it's not silently invisible.
      console.error("Failed to send member-removed notification email:", sendError);
    }
  }

  revalidatePath("/dashboard/members");
  return { error: null, success: true };
}
