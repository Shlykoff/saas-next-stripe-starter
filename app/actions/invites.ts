"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireOrgOwner, ACTIVE_ORG_COOKIE } from "@/lib/org";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { resend, INVITE_EMAIL_FROM } from "@/lib/resend";
import { renderInviteEmail } from "@/lib/emails/invite-email";
import { getAppUrl } from "@/lib/app-url";

export interface InviteActionState {
  error: string | null;
  success?: boolean;
}

// Mirrors app/actions/auth.ts's own EMAIL_RE -- kept as a separate local
// copy rather than importing auth.ts's (which isn't exported) to avoid
// coupling this file to auth.ts's internals for one regex; both must stay
// in sync with organization_invites.email's CHECK constraint in
// supabase/migrations/20260818123625_add_organization_invites.sql.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INVITE_ROLES = ["owner", "member"] as const;
type InviteRole = (typeof INVITE_ROLES)[number];

function isInviteRole(value: string): value is InviteRole {
  return (INVITE_ROLES as readonly string[]).includes(value);
}

/**
 * Server Action backing the "invite a teammate" form
 * (components/invites/invite-member-form.tsx, rendered on
 * app/dashboard/members/page.tsx for owners only).
 *
 * requireOrgOwner does the real authorization (throws for a non-owner --
 * see its own doc comment); the INSERT below goes through the ordinary
 * session-bound client, so RLS policy "organization_invites_insert_owner"
 * is a second, independent backstop against the exact same thing (see
 * supabase/tests/organization_invites_test.sql for that policy proven
 * directly against a non-owner session).
 */
export async function createInvite(
  _prevState: InviteActionState,
  formData: FormData,
): Promise<InviteActionState> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const rawEmail = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "");

  if (!EMAIL_RE.test(rawEmail)) {
    return { error: "Enter a valid email address." };
  }
  if (!isInviteRole(role)) {
    return { error: "Choose a valid role." };
  }

  const { supabase, user } = await requireOrgOwner(organizationId);

  // The DB column has `check (email = lower(email))` -- we must normalize
  // before INSERT, a CHECK only rejects bad input, it doesn't rewrite it
  // (see the migration's own comment on this column).
  const email = rawEmail.toLowerCase();

  const { data: invite, error: insertError } = await supabase
    .from("organization_invites")
    .insert({ organization_id: organizationId, email, role, invited_by: user.id })
    .select("token")
    .single();

  if (insertError) {
    // 23505 = unique_violation on organization_invites_org_email_pending_idx
    // (at most one PENDING invite per (organization, email) at a time).
    if (insertError.code === "23505") {
      return { error: "An invite is already pending for this email." };
    }
    return { error: `Could not create invite: ${insertError.message}` };
  }

  // requireOrgOwner already proved this session is a member (owner) of
  // organizationId, so this read is RLS-safe -- only needed for the email
  // body's organization name.
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .single();

  if (orgError) {
    // The invite row itself was created successfully and is fully valid/
    // acceptable via its link -- only the confirmation email's org-name
    // lookup failed. Don't roll back the invite for this.
    return {
      error: `Invite created, but could not prepare the email: ${orgError.message}. The invite is still valid.`,
    };
  }

  const inviteUrl = `${getAppUrl()}/invite/accept?token=${invite.token}`;

  try {
    await resend.emails.send({
      from: INVITE_EMAIL_FROM,
      to: email,
      subject: `You're invited to join ${org.name}`,
      html: renderInviteEmail({ organizationName: org.name, role, inviteUrl }),
    });
  } catch (sendError) {
    // The invite row exists and is valid/acceptable via its link even if the
    // email never arrives -- don't roll back the DB write for a delivery
    // failure the owner can work around by sharing the link manually or
    // revoking and re-sending later.
    const message = sendError instanceof Error ? sendError.message : "Unknown error";
    return {
      error: `Invite created, but the email failed to send (${message}). Share this link manually: ${inviteUrl}`,
    };
  }

  revalidatePath("/dashboard/members");
  return { error: null, success: true };
}

/**
 * Server Action backing the "Revoke" button on a pending invite
 * (components/invites/revoke-invite-button.tsx). Authorization is entirely
 * RLS's job here (policy "organization_invites_update_owner_revoke", which
 * -- by design -- can ONLY move a row from pending to revoked, never to
 * accepted; see the migration's comment on that policy) -- this action does
 * not re-check ownership itself before attempting the UPDATE. `.select()` is
 * chained onto the update so a genuine "no such invite / not pending / not
 * your org" can be told apart from a real success: an UPDATE RLS silently
 * filters out returns 0 rows and NO error from PostgREST.
 */
export async function revokeInvite(
  _prevState: InviteActionState,
  formData: FormData,
): Promise<InviteActionState> {
  const inviteId = String(formData.get("inviteId") ?? "");
  if (!inviteId) {
    return { error: "Missing invite id." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("organization_invites")
    .update({ status: "revoked" })
    .eq("id", inviteId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: `Could not revoke invite: ${error.message}` };
  }
  if (!data) {
    return { error: "Invite not found, no longer pending, or you don't have permission to revoke it." };
  }

  revalidatePath("/dashboard/members");
  return { error: null, success: true };
}

export interface AcceptInviteActionState {
  error: string | null;
}

/**
 * Server Action backing the "Accept invite" button
 * (components/invites/accept-invite-form.tsx, on app/invite/accept/page.tsx).
 *
 * Uses service_role deliberately: RLS structurally forbids an ordinary
 * authenticated session from ever setting organization_invites.status to
 * 'accepted' (policy "organization_invites_update_owner_revoke" only permits
 * pending -> revoked, and only for an owner acting on their own org's
 * invite -- see the migration's comment), and organization_members INSERT is
 * owner-only ("organization_members_insert_owner"), so an invitee accepting
 * their own invite can never self-insert either. Both writes below MUST go
 * through service_role, which is exactly what makes every check in this
 * function load-bearing: bypassing RLS means nothing here is double-checked
 * by the database the way every other server action in this app can lean on
 * RLS to catch a missed check. Re-verifies status/expiry/email match itself
 * rather than trusting that app/invite/accept/page.tsx already checked --
 * that page's checks are for the initial render only; this action re-runs
 * them against a fresh read at the moment of the actual privileged write.
 *
 * Not a single DB transaction/RPC: the two writes below (INSERT
 * organization_members, then UPDATE organization_invites) are two separate
 * service_role calls rather than one Postgres function wrapping both in a
 * transaction. If the process crashes between them, the user ends up a real,
 * durable member of the organization (the first write already committed) --
 * membership access is safely granted -- but the invite row is left stuck at
 * 'pending' instead of 'accepted'. That's a survivable, self-correcting
 * inconsistency: the invite becomes revoked/re-inviteable-then-expires
 * housekeeping cruft, not a security or data-loss problem, since the
 * `.eq("status", "pending")` guard on the second write (and the unique
 * constraint on organization_members(organization_id, user_id)) make a
 * retried acceptance idempotent -- a second run either no-ops on the
 * already-accepted invite, or hits the membership's unique constraint,
 * which is handled below by reconciling the existing row's role to
 * invite.role (a plain retry needs this to be a true no-op; it's also what
 * makes a re-invite of an already-a-member the mechanism for changing their
 * role, see that branch's own comment) rather than double-granting or
 * corrupting anything. A real Postgres function (SECURITY DEFINER RPC) would
 * close this gap entirely, but was judged not worth the added schema surface
 * for a gap whose worst case is "one invite row's status field is stale."
 */
export async function acceptInvite(
  _prevState: AcceptInviteActionState,
  formData: FormData,
): Promise<AcceptInviteActionState> {
  const token = String(formData.get("token") ?? "").trim();
  if (!token) {
    return { error: "Missing invite token." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return { error: "You must be signed in to accept an invite." };
  }

  const serviceClient = createServiceRoleClient();

  const { data: invite, error: inviteError } = await serviceClient
    .from("organization_invites")
    .select("id, organization_id, email, role, status, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (inviteError) {
    return { error: `Could not load invite: ${inviteError.message}` };
  }
  if (!invite || invite.status !== "pending") {
    return { error: "This invite is no longer valid." };
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return { error: "This invite has expired." };
  }
  if (invite.email !== user.email.toLowerCase()) {
    return {
      error: `This invite was sent to ${invite.email}, but you're signed in as ${user.email}.`,
    };
  }

  const { error: memberError } = await serviceClient
    .from("organization_members")
    .insert({ organization_id: invite.organization_id, user_id: user.id, role: invite.role });

  if (memberError) {
    if (memberError.code === "23505") {
      // unique_violation on (organization_id, user_id): the invitee is
      // ALREADY a member of this organization -- e.g. a double-submitted
      // Accept click (harmless, same role, nothing to change), OR the
      // invite was created specifically to change an existing member's
      // role (there's no dedicated "change role" UI yet, so re-inviting is
      // currently the only mechanism for that -- see
      // components/invites/invite-member-form.tsx). Previously this branch
      // just continued past the insert without touching the existing row,
      // which meant accepting a "promote to owner" re-invite for an
      // already-a-member invitee silently did nothing: they were
      // redirected to /dashboard believing their role changed while the
      // organization_members row was untouched, with no error shown to
      // either them or the inviting owner. Explicitly reconciling the row
      // to invite.role here (a plain UPDATE, still service_role since it
      // runs in the exact same privileged context as the insert above) is
      // what makes the invite's stated role the actual source of truth
      // instead of a silent no-op.
      const { error: updateMemberError } = await serviceClient
        .from("organization_members")
        .update({ role: invite.role })
        .eq("organization_id", invite.organization_id)
        .eq("user_id", user.id);

      if (updateMemberError) {
        // Most likely trg_prevent_last_owner_change rejecting a re-invite
        // that would demote the organization's sole owner (see
        // supabase/migrations/20260817171827_init_core_schema.sql) --
        // surfaced as-is rather than silently succeeding or crashing. The
        // invite itself is left 'pending' in this case (the update below
        // is never reached), so the owner can see it's still outstanding.
        return { error: `Could not update your role: ${updateMemberError.message}` };
      }
    } else {
      return { error: `Could not join the organization: ${memberError.message}` };
    }
  }

  const { error: updateError } = await serviceClient
    .from("organization_invites")
    .update({ status: "accepted", accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq("id", invite.id)
    .eq("status", "pending"); // guards against a concurrent double-accept racing this one

  if (updateError) {
    // Membership already exists at this point -- the user IS in the
    // organization. Only the invite's own bookkeeping failed to update; not
    // worth blocking the redirect over (see this function's doc comment on
    // why this is a survivable inconsistency), but worth logging.
    console.error(
      `Failed to mark invite ${invite.id} as accepted after granting membership to ${user.id}:`,
      updateError.message,
    );
  }

  // Land the user in the workspace they just joined rather than whatever was
  // previously active (relevant once they belong to more than one) -- same
  // cookie the org switcher uses (see lib/org.ts / app/actions/org.ts), set
  // the same way, best-effort (a Server Action can always write cookies, so
  // this isn't expected to fail, but a failure here shouldn't block the
  // redirect -- getActiveOrganization's own fallback covers a missing cookie).
  try {
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_ORG_COOKIE, invite.organization_id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
    });
  } catch {
    // Non-fatal -- see comment above.
  }

  redirect("/dashboard");
}
