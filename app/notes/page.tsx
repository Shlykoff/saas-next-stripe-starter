import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveOrganization } from "@/lib/org";
import { getOrganizationSubscription } from "@/lib/subscriptions";
import { getOrganizationNotes, parseNotePage, parseNoteSort } from "@/lib/notes";
import { hasActiveSubscriptionAccess, subscriptionStatusLabel } from "@/lib/subscription-access";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CreateNoteForm } from "@/components/notes/create-note-form";
import { NoteItem } from "@/components/notes/note-item";
import { NotesToolbar } from "@/components/notes/notes-toolbar";
import { NotesPagination } from "@/components/notes/notes-pagination";
import { NotesRealtime } from "@/components/notes/notes-realtime";

// ---------------------------------------------------------------------------
// Product feature: Notes. Gated to organizations with an active/trialing
// subscription (see lib/subscription-access.ts, unit- and integration-
// tested in tests/subscription-access.test.ts and tests/notes.test.ts).
//
// Backed by the real `notes` table + RLS from
// supabase/migrations/20260817212642_add_notes.sql (db-architect) -- no
// mock data. Reads go through getOrganizationNotes (lib/notes.ts), which is
// itself RLS-scoped and now paginated/searchable/sortable via ?page=/?q=/
// ?sort= (parsed below with parseNotePage/parseNoteSort -- unrecognized or
// out-of-range values fall back to sane defaults rather than erroring);
// writes go through app/actions/notes.ts, which leans on RLS for
// authorization rather than re-checking membership/ownership here. Live
// updates (a teammate's create/edit/delete showing up without a manual
// reload) come from components/notes/notes-realtime.tsx, a private
// Supabase Realtime broadcast channel authorized by RLS on
// realtime.messages (supabase/migrations/20260818174917_enable_notes_realtime.sql)
// -- see that component's doc comment for why postgres_changes was
// deliberately not used.
// ---------------------------------------------------------------------------

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; sort?: string }>;
}) {
  const { page: rawPage, q: rawSearch, sort: rawSort } = await searchParams;
  // Renamed requestedPage (not page) -- getOrganizationNotes below may
  // clamp this to a smaller, real page, and that clamped value (not this
  // raw one) is what the rest of this component should render against.
  const requestedPage = parseNotePage(rawPage);
  const search = (rawSearch ?? "").trim();
  const sort = parseNoteSort(rawSort);

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

  // `page` below is the CLAMPED page getOrganizationNotes actually served
  // (it may differ from the requested `page` above -- a stale/tampered/huge
  // ?page= is clamped to the last real page rather than erroring, see that
  // function's doc comment), so the empty-state copy and NotesPagination
  // below reflect what was really returned, not what was asked for.
  const {
    notes,
    page,
    totalCount,
    totalPages,
    pageSize,
  } = await getOrganizationNotes(supabase, organization.id, {
    page: requestedPage,
    search,
    sort,
  });
  const isOwner = organization.role === "owner";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
      {/* Renders nothing -- subscribes to this org's private Realtime
          broadcast channel and calls router.refresh() when a teammate (or
          this same user, in another tab) creates/edits/deletes a note. See
          that component's doc comment for why this is a private broadcast
          channel and not postgres_changes. */}
      <NotesRealtime organizationId={organization.id} />

      <div>
        <h1 className="text-2xl font-semibold">Notes</h1>
        <p className="text-sm text-muted-foreground">Shared with everyone in {organization.name}.</p>
      </div>

      <CreateNoteForm organizationId={organization.id} />

      <NotesToolbar initialSearch={search} initialSort={sort} />

      {notes.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {search ? (
              <>No notes match &ldquo;{search}&rdquo;. Try a different search term.</>
            ) : page > 1 ? (
              <>No notes on this page. Go back to page 1.</>
            ) : (
              <>No notes yet. Add your first one above to get started.</>
            )}
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
              currentUserId={user.id}
              isOrgOwner={isOwner}
            />
          ))}
        </div>
      )}

      <NotesPagination
        page={page}
        totalPages={totalPages}
        totalCount={totalCount}
        pageSize={pageSize}
        currentCount={notes.length}
        search={search}
        sort={sort}
      />
    </main>
  );
}
