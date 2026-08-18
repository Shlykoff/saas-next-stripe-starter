import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { AcceptInviteForm } from "@/components/invites/accept-invite-form";
import { signOut } from "@/app/actions/auth";
import { cn } from "@/lib/utils";

// Not gated by proxy.ts's PROTECTED_PREFIXES (only /dashboard, /notes,
// /onboarding) -- this page must be reachable while signed OUT, so it can
// show the "sign in / sign up, then come back here" screen below. Every
// check here (token found, still pending, not expired, email match) is
// UX only -- app/actions/invites.ts's acceptInvite Server Action re-runs
// all of the same checks itself against a fresh read at the moment of the
// actual privileged write, per that function's own doc comment, so a stale
// render here can never let an invalid accept through.
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">{await resolveInviteScreen(token)}</main>;
}

async function resolveInviteScreen(token: string | undefined) {
  if (!token) {
    return <InvalidInviteCard />;
  }

  // service_role: RLS policy "organization_invites_select_owner" only lets
  // the inviting organization's OWNER read invite rows -- the invitee
  // clicking this link is neither signed in yet, nor (even once signed in)
  // an owner of the org they're being invited to. Read-only lookup by the
  // opaque `token` from the URL, same posture as
  // app/actions/invites.ts's acceptInvite.
  const serviceClient = createServiceRoleClient();
  const { data: invite, error } = await serviceClient
    .from("organization_invites")
    .select("id, organization_id, email, role, status, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error || !invite || invite.status !== "pending" || new Date(invite.expires_at).getTime() < Date.now()) {
    return <InvalidInviteCard />;
  }

  const { data: org } = await serviceClient
    .from("organizations")
    .select("name")
    .eq("id", invite.organization_id)
    .maybeSingle();
  const organizationName = org?.name ?? "this organization";

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const nextPath = `/invite/accept?token=${token}`;

  if (!user) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">You&apos;re invited to {organizationName}</CardTitle>
          <CardDescription>
            Sign in or create an account with <strong>{invite.email}</strong> to join as{" "}
            <strong>{invite.role}</strong>.
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex gap-2">
          <Link href={`/login?next=${encodeURIComponent(nextPath)}`} className={cn(buttonVariants())}>
            Sign in
          </Link>
          <Link
            href={`/signup?next=${encodeURIComponent(nextPath)}`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Sign up
          </Link>
        </CardFooter>
      </Card>
    );
  }

  if (!user.email || user.email.toLowerCase() !== invite.email) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Wrong account</CardTitle>
          <CardDescription>
            This invite was sent to <strong>{invite.email}</strong>, but you&apos;re signed in as{" "}
            <strong>{user.email}</strong>.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <form action={signOut}>
            <Button type="submit" variant="outline">
              Sign out
            </Button>
          </form>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Join {organizationName}</CardTitle>
        <CardDescription>
          You&apos;ve been invited to join as <strong>{invite.role}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AcceptInviteForm token={token} />
      </CardContent>
    </Card>
  );
}

function InvalidInviteCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Invite not found</CardTitle>
      </CardHeader>
      <CardContent>
        <Alert variant="destructive">
          <AlertTitle>This invite is no longer valid</AlertTitle>
          <AlertDescription>
            It may have been revoked, already used, or expired. Ask the organization owner to send a
            new one.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
