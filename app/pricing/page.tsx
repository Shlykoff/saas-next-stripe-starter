import { createCheckoutSession } from "@/app/actions/billing";
import { PLANS, resolvePlanPriceId } from "@/lib/plans";

// Placeholder pricing page: minimal enough to exercise
// app/actions/billing.ts's createCheckoutSession end-to-end. nextjs-frontend
// owns the real design/layout for this page in a later stage; this is not
// meant to be the final UI.
//
// organizationId is hardcoded as a query param placeholder for now because
// there's no onboarding flow / org switcher yet (that's nextjs-frontend's
// stage too) -- once it exists, this page should read the user's active
// organization from their session instead of a query param.
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org: organizationId } = await searchParams;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <h1 className="text-2xl font-semibold">Pricing</h1>
      {!organizationId && (
        <p className="rounded border border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-900">
          No organization selected. Visit this page as
          {" "}
          <code>/pricing?org=&lt;organization_id&gt;</code>
          {" "}
          until the onboarding flow picks this up automatically.
        </p>
      )}
      <div className="grid gap-6 sm:grid-cols-2">
        {PLANS.map((plan) => {
          const priceId = resolvePlanPriceId(plan);
          return (
            <div key={plan.id} className="flex flex-col gap-4 rounded-lg border p-6">
              <div>
                <h2 className="text-lg font-medium">{plan.name}</h2>
                <p className="text-sm text-zinc-500">{plan.description}</p>
              </div>
              <form action={createCheckoutSession}>
                <input type="hidden" name="organizationId" value={organizationId ?? ""} />
                <input type="hidden" name="priceId" value={priceId ?? ""} />
                <button
                  type="submit"
                  disabled={!organizationId || !priceId}
                  className="w-full rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
                >
                  {priceId ? "Subscribe" : "Not configured (missing price id in .env)"}
                </button>
              </form>
            </div>
          );
        })}
      </div>
    </main>
  );
}
