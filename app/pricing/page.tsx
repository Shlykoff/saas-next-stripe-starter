import Link from "next/link";
import { createCheckoutSession } from "@/app/actions/billing";
import { PLANS, resolvePlanPriceId } from "@/lib/plans";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveOrganization } from "@/lib/org";
import { getOrganizationSubscription } from "@/lib/subscriptions";
import { hasActiveSubscriptionAccess } from "@/lib/subscription-access";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const organization = user ? await getActiveOrganization(supabase, user.id) : null;
  const subscription =
    user && organization ? await getOrganizationSubscription(supabase, organization.id) : null;
  const hasAccess = hasActiveSubscriptionAccess(subscription?.status);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
        <p className="text-muted-foreground">Simple plans. Cancel any time.</p>
      </div>

      {checkout === "cancelled" && (
        <Alert>
          <AlertTitle>Checkout cancelled</AlertTitle>
          <AlertDescription>No charge was made. Pick a plan below whenever you&apos;re ready.</AlertDescription>
        </Alert>
      )}

      {!user && (
        <Alert>
          <AlertTitle>Sign in to subscribe</AlertTitle>
          <AlertDescription>
            Create an account or sign in first -- subscriptions belong to your organization.
          </AlertDescription>
        </Alert>
      )}

      {user && !organization && (
        <Alert>
          <AlertTitle>Create your workspace first</AlertTitle>
          <AlertDescription>
            You need a workspace before subscribing.{" "}
            <Link href="/onboarding" className="underline underline-offset-4">
              Create one now
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      {user && organization && organization.role !== "owner" && (
        <Alert>
          <AlertTitle>Billing is managed by your workspace owner</AlertTitle>
          <AlertDescription>
            Only the owner of &quot;{organization.name}&quot; can subscribe or change plans.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        {PLANS.map((plan) => {
          const priceId = resolvePlanPriceId(plan);
          const isCurrentPlan = hasAccess && subscription?.stripe_price_id === priceId;

          return (
            <Card key={plan.id} className={cn(isCurrentPlan && "ring-2 ring-primary")}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xl">{plan.name}</CardTitle>
                  {isCurrentPlan && <Badge>Current plan</Badge>}
                </div>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1" />
              <CardFooter className="border-t-0 bg-transparent pt-0">
                {isCurrentPlan ? (
                  <Link
                    href="/dashboard"
                    className={cn(buttonVariants({ variant: "outline" }), "w-full")}
                  >
                    Manage in dashboard
                  </Link>
                ) : !user ? (
                  <Link href="/login?next=/pricing" className={cn(buttonVariants(), "w-full")}>
                    Sign in to subscribe
                  </Link>
                ) : !organization ? (
                  <Link href="/onboarding" className={cn(buttonVariants(), "w-full")}>
                    Create a workspace first
                  </Link>
                ) : organization.role !== "owner" ? (
                  <Button className="w-full" disabled>
                    Owner only
                  </Button>
                ) : hasAccess ? (
                  // Org already has an active subscription to a DIFFERENT
                  // plan. Deliberately not another Checkout Session here --
                  // Checkout in "subscription" mode would start a second,
                  // separate Stripe subscription for the same customer
                  // rather than change the existing one. Plan switching for
                  // an already-subscribed org belongs in the Customer
                  // Portal (app/actions/billing.ts's createPortalSession),
                  // which Stripe can configure to allow swapping Prices on
                  // the existing subscription.
                  <Link
                    href="/dashboard"
                    className={cn(buttonVariants({ variant: "outline" }), "w-full")}
                  >
                    Switch in dashboard
                  </Link>
                ) : !priceId ? (
                  <Button className="w-full" disabled>
                    Not configured yet
                  </Button>
                ) : (
                  <form action={createCheckoutSession} className="w-full">
                    <input type="hidden" name="organizationId" value={organization.id} />
                    <input type="hidden" name="priceId" value={priceId} />
                    <Button type="submit" className="w-full">
                      Subscribe
                    </Button>
                  </form>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
