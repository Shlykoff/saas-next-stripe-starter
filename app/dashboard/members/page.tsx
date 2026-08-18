import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getActiveOrganization } from "@/lib/org";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { InviteMemberForm } from "@/components/invites/invite-member-form";
import { RevokeInviteButton } from "@/components/invites/revoke-invite-button";

// ---------------------------------------------------------------------------
// Members & invites. Two independent lists:
//   - roster (organization_members): visible to every member, read-only for
//     everyone (no role management UI yet -- out of scope for this pass).
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
    .select("user_id, role, created_at")
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
          {(members ?? []).map((member, index) => (
            <div key={member.user_id}>
              {index > 0 && <Separator className="mb-3" />}
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {emailByUserId.get(member.user_id) ?? "Unknown user"}
                    {member.user_id === user.id && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>
                    )}
                  </p>
                </div>
                <Badge variant={member.role === "owner" ? "default" : "secondary"} className="shrink-0">
                  {member.role}
                </Badge>
              </div>
            </div>
          ))}
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
