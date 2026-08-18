import Link from "next/link";
import { redirect } from "next/navigation";
import { createPortalSession } from "@/app/actions/billing";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveOrganization } from "@/lib/org";
import { getOrganizationSubscription } from "@/lib/subscriptions";
import {
  hasActiveSubscriptionAccess,
  subscriptionStatusBadgeVariant,
  subscriptionStatusLabel,
} from "@/lib/subscription-access";
import { planForPriceId } from "@/lib/plans";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;

  // Real auth + org gate (defense in depth alongside proxy.ts).
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard");
  }

  const organization = await getActiveOrganization(supabase, user.id);
  if (!organization) {
    redirect("/onboarding");
  }

  const subscription = await getOrganizationSubscription(supabase, organization.id);
  const hasAccess = hasActiveSubscriptionAccess(subscription?.status);
  const plan = planForPriceId(subscription?.stripe_price_id);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">{organization.name}</p>
      </div>

      {checkout === "success" && (
        <Alert>
          <AlertTitle>Checkout complete</AlertTitle>
          <AlertDescription>
            Subscription status updates asynchronously via the Stripe webhook -- refresh in a
            moment if it isn&apos;t reflected below yet.
          </AlertDescription>
        </Alert>
      )}

      {!hasAccess && (
        <Alert variant="destructive">
          <AlertTitle>
            {subscription?.status ? "Your subscription needs attention" : "No active subscription"}
          </AlertTitle>
          <AlertDescription>
            {subscription?.status === "past_due" || subscription?.status === "unpaid"
              ? "Your last payment failed. Update your billing details to keep access."
              : "Subscribe to a plan to unlock the Notes feature and the rest of the product."}{" "}
            <Link href="/pricing" className="underline underline-offset-4">
              View plans
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              {plan ? `${plan.name} plan` : "Subscription"}
            </CardTitle>
            <Badge variant={subscriptionStatusBadgeVariant(subscription?.status)}>
              {subscriptionStatusLabel(subscription?.status)}
            </Badge>
          </div>
          <CardDescription>
            {subscription?.current_period_end
              ? `Renews ${new Date(subscription.current_period_end).toLocaleDateString()}${
                  subscription.cancel_at_period_end ? " (cancels at period end)" : ""
                }`
              : "Your organization has not subscribed to a plan yet."}
          </CardDescription>
        </CardHeader>
        <CardContent />
        <CardFooter>
          {organization.role === "owner" ? (
            subscription?.stripe_customer_id ? (
              <form action={createPortalSession}>
                <input type="hidden" name="organizationId" value={organization.id} />
                <Button type="submit" variant="outline">
                  Manage billing
                </Button>
              </form>
            ) : (
              <Button render={<Link href="/pricing" />}>Choose a plan</Button>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              Only the workspace owner can manage billing.
            </p>
          )}
        </CardFooter>
      </Card>
    </main>
  );
}
