import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveOrganization } from "@/lib/org";
import { getOrganizationSubscription } from "@/lib/subscriptions";
import { getOrganizationNotes } from "@/lib/notes";
import { hasActiveSubscriptionAccess, subscriptionStatusLabel } from "@/lib/subscription-access";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CreateNoteForm } from "@/components/notes/create-note-form";
import { NoteItem } from "@/components/notes/note-item";

// ---------------------------------------------------------------------------
// Product feature: Notes. Gated to organizations with an active/trialing
// subscription (see lib/subscription-access.ts, unit- and integration-
// tested in tests/subscription-access.test.ts and tests/notes.test.ts).
//
// Backed by the real `notes` table + RLS from
// supabase/migrations/20260817212642_add_notes.sql (db-architect) -- no
// mock data. Reads go through getOrganizationNotes (lib/notes.ts), which is
// itself RLS-scoped; writes go through app/actions/notes.ts, which leans on
// RLS for authorization rather than re-checking membership/ownership here.
// ---------------------------------------------------------------------------

export default async function NotesPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/notes");
  }

  const organization = await getActiveOrganization(supabase, user.id);
  if (!organization) {
    redirect("/onboarding");
  }

  const subscription = await getOrganizationSubscription(supabase, organization.id);

  // The actual gate. This is a server-side decision made from a
  // session/RLS-scoped DB read (getOrganizationSubscription -- see its own
  // doc comment on why RLS makes this safe even against a forged
  // organization.id), not a client-side flag and not just a hidden button:
  // an org without qualifying access never receives the notes markup at
  // all, so there's nothing to "unhide" via devtools.
  if (!hasActiveSubscriptionAccess(subscription?.status)) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
        <h1 className="text-2xl font-semibold">Notes</h1>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Subscribe to unlock Notes</CardTitle>
            <CardDescription>
              {subscription?.status
                ? `Your subscription is currently "${subscriptionStatusLabel(subscription.status)}", which doesn't include this feature.`
                : "This feature is available on any paid plan."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/pricing" className={cn(buttonVariants())}>
              View plans
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const notes = await getOrganizationNotes(supabase, organization.id);
  const isOwner = organization.role === "owner";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold">Notes</h1>
        <p className="text-sm text-muted-foreground">Shared with everyone in {organization.name}.</p>
      </div>

      <CreateNoteForm organizationId={organization.id} />

      {notes.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No notes yet. Add your first one above to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {notes.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              isOwnNote={note.author_id === user.id}
              canManage={note.author_id === user.id || isOwner}
            />
          ))}
        </div>
      )}
    </main>
  );
}
