import { createPortalSession } from "@/app/actions/billing";

// Placeholder dashboard: real subscription-status UI, org context, and the
// product feature (notes/tasks) are nextjs-frontend's stage. This exists so
// Checkout's success_url and the Customer Portal's return_url
// (app/actions/billing.ts) point at a real route instead of a dead link.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; checkout?: string }>;
}) {
  const { org: organizationId, checkout } = await searchParams;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      {checkout === "success" && (
        <p className="rounded border border-green-400 bg-green-50 p-3 text-sm text-green-900">
          Checkout complete. Subscription status updates asynchronously via
          the Stripe webhook -- refresh in a moment if it isn&apos;t reflected yet.
        </p>
      )}
      {organizationId ? (
        <form action={createPortalSession}>
          <input type="hidden" name="organizationId" value={organizationId} />
          <button
            type="submit"
            className="rounded border px-4 py-2 text-sm font-medium"
          >
            Manage billing
          </button>
        </form>
      ) : (
        <p className="text-sm text-zinc-500">
          No organization selected (
          <code>/dashboard?org=&lt;organization_id&gt;</code>
          ).
        </p>
      )}
    </main>
  );
}
