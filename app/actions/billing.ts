"use server";

import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { allowedPriceIds } from "@/lib/plans";

function getAppUrl(): string {
  // NEXT_PUBLIC_APP_URL is the canonical base URL for redirect targets
  // (Stripe requires absolute URLs for success_url/cancel_url/return_url).
  // Falls back to localhost so `npm run dev` works without extra setup.
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * Verifies the current signed-in user is an OWNER of `organizationId` before
 * doing anything billing-related. Billing is an owner-only action per the
 * schema's role model (see organization_members.role check + comments in
 * supabase/migrations/20260817171827_init_core_schema.sql).
 *
 * IMPORTANT: this does not just check the shape of the client-supplied
 * organizationId -- the SELECT itself is RLS-gated (is_org_member /
 * is_org_owner), so a user who isn't actually a member of that org gets
 * zero rows back no matter what id they pass in. We never trust the client
 * to tell us who they are; we always look it up against their own session.
 */
async function requireOrgOwner(organizationId: string) {
  if (!organizationId) {
    throw new Error("Missing organizationId.");
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership, error } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify organization membership: ${error.message}`);
  }

  if (!membership || membership.role !== "owner") {
    throw new Error("Only an organization owner can manage billing.");
  }

  return { supabase, user, organizationId };
}

/**
 * Server Action backing the "Subscribe" button on the pricing page.
 * Creates a Stripe Checkout Session and redirects the browser to it.
 *
 * organization_id is stamped onto both `client_reference_id` AND
 * `subscription_data.metadata` -- the former is read by the webhook's
 * checkout.session.completed handler, the latter is inherited by the
 * resulting Subscription object itself, so every later
 * customer.subscription.* event for it also carries organization_id in its
 * own metadata without the webhook needing to look anything up.
 */
export async function createCheckoutSession(formData: FormData) {
  const organizationId = String(formData.get("organizationId") ?? "");
  const priceId = String(formData.get("priceId") ?? "");

  const { supabase, user } = await requireOrgOwner(organizationId);

  if (!allowedPriceIds().includes(priceId)) {
    throw new Error("Unknown or unconfigured price id.");
  }

  // Reuse an existing Stripe Customer for this org if we already have one
  // (e.g. a previously canceled subscription), so we don't fragment billing
  // history across multiple Customer objects for the same organization.
  const { data: existingSubscription } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const appUrl = getAppUrl();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: organizationId,
    ...(existingSubscription?.stripe_customer_id
      ? { customer: existingSubscription.stripe_customer_id }
      : { customer_email: user.email }),
    metadata: { organization_id: organizationId },
    subscription_data: {
      metadata: { organization_id: organizationId },
    },
    success_url: `${appUrl}/dashboard?checkout=success`,
    cancel_url: `${appUrl}/pricing?checkout=cancelled`,
  });

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout Session URL.");
  }

  redirect(session.url);
}

/**
 * Server Action backing the "Manage billing" button in the dashboard.
 * Creates a Stripe Customer Portal Session and redirects the browser to it.
 * return_url points at the real (future) dashboard route, not a bare
 * localhost root -- nextjs-frontend builds out app/dashboard/page.tsx, this
 * action just needs the path to already be correct.
 */
export async function createPortalSession(formData: FormData) {
  const organizationId = String(formData.get("organizationId") ?? "");
  const { supabase } = await requireOrgOwner(organizationId);

  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load subscription: ${error.message}`);
  }

  if (!subscription?.stripe_customer_id) {
    throw new Error(
      "This organization has no Stripe customer yet -- subscribe to a plan first.",
    );
  }

  const appUrl = getAppUrl();

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: subscription.stripe_customer_id,
    return_url: `${appUrl}/dashboard`,
  });

  redirect(portalSession.url);
}
