import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getActiveOrganization } from "@/lib/org";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { InviteMemberForm } from "@/components/invites/invite-member-form";
import { RevokeInviteButton } from "@/components/invites/revoke-invite-button";
import { RemoveMemberButton } from "@/components/members/remove-member-button";
import { ChangeRoleSelect } from "@/components/members/change-role-select";
import { RefreshOnFocus } from "@/components/refresh-on-focus";

// ---------------------------------------------------------------------------
// Members & invites. Two independent lists:
//   - roster (organization_members): visible to every member. Owners can
//     remove any OTHER member (never themselves from here -- see the
//     `isOwner` branch below); a non-owner can remove only themselves
//     ("Leave organization"). Both are the same removeMember Server Action
//     (app/actions/org.ts), authorized entirely by RLS policy
//     "organization_members_delete_owner_or_self" (supabase/migrations/
//     20260817171827_init_core_schema.sql: is_org_owner(organization_id) OR
//     user_id = auth.uid()) -- no role management UI yet beyond that, out
//     of scope for this pass.
//   - pending invites (organization_invites): visible AND manageable
//     (create/revoke) by the organization owner only, per RLS policies
//     "organization_invites_select_owner" / "..._insert_owner" /
//     "..._update_owner_revoke" in
//     supabase/migrations/20260818123625_add_organization_invites.sql. A
//     non-owner never even receives this section's markup -- see the
//     `isOwner` guard below -- not just a hidden form.
// ---------------------------------------------------------------------------

export default async function MembersPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/members");
  }

  const organization = await getActiveOrganization(supabase, user.id);
  if (!organization) {
    redirect("/onboarding");
  }

  const isOwner = organization.role === "owner";

  const { data: members, error: membersError } = await supabase
    .from("organization_members")
    .select("id, user_id, role, created_at")
    .eq("organization_id", organization.id)
    .order("created_at", { ascending: true });

  if (membersError) {
    throw new Error(`Failed to load members: ${membersError.message}`);
  }

  // organization_members has no email column, and auth.users is a
  // Supabase-managed schema this session's anon-key client cannot query
  // directly (it's not `public`, and isn't exposed via PostgREST). Two ways
  // to show a roster with emails: (a) duplicate email onto
  // organization_members and keep it in sync whenever auth.users.email
  // changes, or (b) a read-only service_role lookup scoped to exactly the
  // member ids the RLS-scoped query above already proved belong to this
  // organization. (a) adds a sync problem (a stale/duplicated copy of data
  // Supabase Auth already owns) for a value that's only ever rendered, never
  // queried/filtered on; (b) is a plain SELECT with no privileged write, and
  // the id list it's scoped to came from an RLS-gated read, not a
  // client-supplied value -- so it doesn't introduce a new trust boundary.
  // Chosen: (b).
  const serviceClient = createServiceRoleClient();
  const emailByUserId = new Map<string, string>();
  await Promise.all(
    (members ?? []).map(async (member) => {
      const { data } = await serviceClient.auth.admin.getUserById(member.user_id);
      if (data.user?.email) {
        emailByUserId.set(member.user_id, data.user.email);
      }
    }),
  );

  const invites = isOwner
    ? await (async () => {
        const { data, error } = await supabase
          .from("organization_invites")
          .select("id, email, role, status, created_at, expires_at")
          .eq("organization_id", organization.id)
          .eq("status", "pending")
          .order("created_at", { ascending: false });
        if (error) {
          throw new Error(`Failed to load invites: ${error.message}`);
        }
        return data ?? [];
      })()
    : [];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
      {/*
        Pending invites can be accepted from a different tab/browser/session
        than the one an owner is looking at this page in (see
        components/refresh-on-focus.tsx). Without this, an owner who left
        this tab open sees a stale "pending" invite until they reload by
        hand.
      */}
      <RefreshOnFocus />

      <div>
        <h1 className="text-2xl font-semibold">Members</h1>
        <p className="text-sm text-muted-foreground">{organization.name}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">People</CardTitle>
          <CardDescription>Everyone currently in this workspace.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(members ?? []).map((member, index) => {
            const email = emailByUserId.get(member.user_id) ?? "Unknown user";
            const isSelf = member.user_id === user.id;
            // Owner removing a teammate: shown for every OTHER member, never
            // for the owner's own row -- removing yourself while owner is a
            // separate, riskier flow (it can hit trg_prevent_last_owner_change
            // if you're the sole owner) that this page deliberately doesn't
            // surface a button for, to avoid conflating "manage the team"
            // with "leave and possibly strand the organization". The server
            // action would still refuse it safely either way (see
            // app/actions/org.ts's removeMember), this is purely about not
            // inviting the click.
            const canOwnerRemove = isOwner && !isSelf;
            // Non-owner leaving voluntarily: RLS allows removing your own
            // membership row regardless of role, so this is offered to any
            // non-owner viewing their own row.
            const canLeave = !isOwner && isSelf;

            return (
              <div key={member.user_id}>
                {index > 0 && <Separator className="mb-3" />}
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {email}
                      {isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canOwnerRemove ? (
                      // Editable for every OTHER member when viewed by the
                      // owner -- see ChangeRoleSelect's own doc comment for
                      // why this is never shown next to the owner's own row.
                      <ChangeRoleSelect
                        memberId={member.id}
                        currentRole={member.role}
                        ariaLabel={`Change ${email}'s role in ${organization.name}`}
                      />
                    ) : (
                      <Badge variant={member.role === "owner" ? "default" : "secondary"}>{member.role}</Badge>
                    )}
                    {canOwnerRemove && (
                      <RemoveMemberButton
                        memberId={member.id}
                        variant="remove"
                        ariaLabel={`Remove ${email} from ${organization.name}`}
                        confirmMessage={`Remove ${email} from ${organization.name}? They'll immediately lose access.`}
                      />
                    )}
                    {canLeave && (
                      <RemoveMemberButton
                        memberId={member.id}
                        variant="leave"
                        ariaLabel={`Leave ${organization.name}`}
                        confirmMessage={`Leave ${organization.name}? You'll immediately lose access to its notes and billing.`}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invite a teammate</CardTitle>
            <CardDescription>They&apos;ll get an email with a link to join.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <InviteMemberForm organizationId={organization.id} />

            {invites.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invites.</p>
            ) : (
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-muted-foreground">Pending invites</h2>
                {invites.map((invite, index) => (
                  <div key={invite.id}>
                    {index > 0 && <Separator className="mb-3" />}
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{invite.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {invite.role} &middot; expires{" "}
                          {new Date(invite.expires_at).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </p>
                      </div>
                      <RevokeInviteButton inviteId={invite.id} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the workspace owner can invite new members or manage pending invites.
        </p>
      )}
    </main>
  );
}
