"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { ACTIVE_ORG_COOKIE } from "@/lib/org";
import { resend, INVITE_EMAIL_FROM } from "@/lib/resend";
import { renderMemberRemovedEmail } from "@/lib/emails/member-removed-email";
import { renderRoleChangedEmail } from "@/lib/emails/role-changed-email";

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

export interface ChangeMemberRoleActionState {
  error: string | null;
  success?: boolean;
}

/**
 * Server Action backing the role <Select> next to each OTHER member on
 * app/dashboard/members/page.tsx (owner-only; there's deliberately no
 * self-service "change my own role" control -- see the page's comment on
 * canOwnerRemove/canLeave for the same reasoning applied here). Authorized
 * by RLS policy "organization_members_update_owner" (supabase/migrations/
 * 20260817171827_init_core_schema.sql: is_org_owner(organization_id)) --
 * this action does not re-check ownership itself, same posture as
 * removeMember/revokeInvite/deleteNote elsewhere in this app.
 *
 * Note this is the ONLY way to change an existing member's role in this
 * app: re-inviting an existing member (createInvite's 23505 branch in
 * app/actions/invites.ts) also reconciles role as a side effect of
 * accepting a fresh invite, but that requires the invitee to click a new
 * email link -- this is the direct, no-round-trip path for an owner who
 * just wants to flip someone from member to owner or back.
 *
 * Reads the current role first (rather than blindly UPDATEing and
 * comparing before/after) so a same-as-current submission is a genuine
 * no-op: no UPDATE, no notification email, no revalidate -- not because an
 * UPDATE to an unchanged value would be unsafe, but because sending "your
 * role changed" for a change that didn't happen would be a real bug, not a
 * cosmetic one.
 */
export async function changeMemberRole(
  _prevState: ChangeMemberRoleActionState,
  formData: FormData,
): Promise<ChangeMemberRoleActionState> {
  const memberId = String(formData.get("memberId") ?? "");
  const role = String(formData.get("role") ?? "");

  if (!memberId) {
    return { error: "Missing member id." };
  }
  if (role !== "owner" && role !== "member") {
    return { error: "Invalid role." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { data: current, error: currentError } = await supabase
    .from("organization_members")
    .select("id, user_id, organization_id, role")
    .eq("id", memberId)
    .maybeSingle();

  if (currentError) {
    return { error: `Could not load member: ${currentError.message}` };
  }
  if (!current) {
    // RLS-filtered to zero rows (not owner / wrong org) or a genuinely
    // stale id -- same "not found or not allowed" phrasing as removeMember,
    // for the same reason: PostgREST can't distinguish the two, and
    // shouldn't reveal which one it is to a caller who might not be
    // authorized to know the row exists at all.
    return { error: "Member not found, or you don't have permission to change their role." };
  }
  if (current.role === role) {
    return { error: null, success: true };
  }

  // `.select()` chained onto the update, same reasoning as removeMember's
  // delete above: RLS silently filtering this UPDATE to zero matching rows
  // (a non-owner attempting it -- policy "organization_members_update_owner"
  // only authorizes is_org_owner(organization_id)) returns 0 rows and NO
  // error from PostgREST. The pre-fetch above already confirmed the row
  // exists and its role differs, so `updateError` alone can't tell a real
  // "not allowed" apart from a real success -- checking `data` here is what
  // actually does that (caught by this file's own test suite: without this,
  // a non-owner's blocked update silently returned {error: null,
  // success: true} and even sent the "your role changed" notification for a
  // change that never happened).
  const { data: updated, error: updateError } = await supabase
    .from("organization_members")
    .update({ role })
    .eq("id", memberId)
    .select("id")
    .maybeSingle();

  if (updateError) {
    // trg_prevent_last_owner_change (supabase/migrations/
    // 20260817171827_init_core_schema.sql) also fires on UPDATE when
    // old.role='owner' and new.role<>'owner' -- demoting the organization's
    // sole owner lands here, not as a silent success. Not actually reachable
    // via this page's own UI today (the role control is never rendered next
    // to the owner's own row -- see the page's canOwnerRemove/canLeave
    // comment), but a defensive owner-of-owner scenario or a future UI
    // change could still hit it, so it's handled rather than left to crash.
    if (updateError.message.includes("Cannot remove the last owner")) {
      return {
        error:
          "This organization's sole owner can't be demoted. Promote another member to owner first.",
      };
    }
    return { error: `Could not update role: ${updateError.message}` };
  }
  if (!updated) {
    // RLS silently matched zero rows -- the caller isn't the org's owner.
    // Same phrasing as the pre-fetch's own "not found or not allowed"
    // branch above and as removeMember's equivalent check, for the same
    // reason: don't reveal whether the row exists to a caller who isn't
    // authorized to know.
    return { error: "Member not found, or you don't have permission to change their role." };
  }

  // Best-effort notify the member whose role changed -- same posture as
  // removeMember's notification (never rolls back the change itself for a
  // delivery failure). Unlike removeMember, this member's row still exists
  // (only their role changed, not their membership), so the org-name lookup
  // and the notification's own recipient both come from data already in
  // hand -- only the email address itself needs service_role, for the same
  // reason as removeMember: organization_members has no email column, and
  // the anon-key session client can't read auth.users directly.
  const serviceClient = createServiceRoleClient();
  const [{ data: memberUser }, { data: org }] = await Promise.all([
    serviceClient.auth.admin.getUserById(current.user_id),
    supabase.from("organizations").select("name").eq("id", current.organization_id).single(),
  ]);

  if (memberUser.user?.email && org?.name) {
    try {
      await resend.emails.send({
        from: INVITE_EMAIL_FROM,
        to: memberUser.user.email,
        subject: `Your role in ${org.name} changed`,
        html: renderRoleChangedEmail({ organizationName: org.name, newRole: role }),
      });
    } catch (sendError) {
      console.error("Failed to send role-changed notification email:", sendError);
    }
  }

  revalidatePath("/dashboard/members");
  return { error: null, success: true };
}
