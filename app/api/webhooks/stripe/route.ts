import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { claimStripeEvent, markStripeEventSucceeded } from "@/lib/webhooks/idempotency";

// Node runtime: the Stripe SDK's default signature verification and the
// service-role Supabase client both rely on Node APIs. Note this is
// unrelated to body parsing -- unlike the old Pages Router API routes,
// App Router Route Handlers NEVER auto-parse the request body for you
// there's no `bodyParser: false` config to set here. The only thing that
// matters for signature verification is that we read the body with
// `req.text()` (raw string) below and never call `req.json()` on it first.
export const runtime = "nodejs";

type SupabaseServiceRoleClient = ReturnType<typeof createServiceRoleClient>;

// Events handled below (see the switch in POST): checkout.session.completed,
// customer.subscription.created/updated/deleted, invoice.payment_failed.
// Any other event type still gets claimed in the idempotency ledger (so we
// never re-inspect it) but falls through the switch's default with no effect.

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured.");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  // MUST be the exact raw bytes Stripe signed. constructEvent recomputes an
  // HMAC over this string and compares it to the signature header -- any
  // parse/reformat/reserialize round trip (even just whitespace) changes the
  // bytes and breaks verification. This is the one non-negotiable rule for
  // this endpoint (CLAUDE.md #4): never call req.json() before this line.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("Stripe webhook signature verification failed:", message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  // --- Idempotency claim ---------------------------------------------------
  // See lib/webhooks/idempotency.ts for the full rationale (this replaces an
  // earlier insert-then-delete-on-failure version that had a genuine,
  // qa-reviewer-reproduced TOCTOU race: a concurrent redelivery could read
  // "row exists" as "already succeeded" while the original attempt was
  // still mid-flight, ack 200, and then have that original attempt fail and
  // delete the claim -- silently dropping the event with no future retry).
  // claimStripeEvent's only possible outcomes are "I own this, proceed" or
  // "I definitely observed status=succeeded, ack duplicate" or "retry me
  // later" -- never a false-positive ack of an unapplied effect.
  const claim = await claimStripeEvent(supabase, event);

  if (!claim.owned) {
    if (claim.alreadySucceeded) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    // Another request (concurrent redelivery, or a crashed-but-not-yet-stale
    // prior attempt) currently holds this event's claim. Returning 200 here
    // would be exactly the false-positive ack this replaces -- respond with
    // a retryable status instead so Stripe tries again later, by which
    // point the in-flight attempt will have resolved to succeeded (normal
    // case) or gone stale and become reclaimable (crash case).
    return NextResponse.json(
      { error: "Event is already being processed, retry later" },
      { status: 409 },
    );
  }

  // Fencing token for this specific claim attempt -- must be threaded
  // through to markStripeEventSucceeded below so a claim that gets
  // reclaimed as stale WHILE this handler is still (slowly, not crashed)
  // running can detect it no longer owns the row, instead of blindly
  // overwriting a newer claim's state. See lib/webhooks/idempotency.ts.
  const { claimToken } = claim;

  // --- Dispatch -------------------------------------------------------------
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(
          supabase,
          event.data.object as Stripe.Checkout.Session,
        );
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        // .deleted's payload is a Subscription whose status is already
        // 'canceled' -- upserting it through the same path as
        // created/updated keeps status/period/cancel_at_period_end in sync
        // with exactly what Stripe sent, no separate "mark canceled" branch
        // needed.
        await handleSubscriptionUpsert(supabase, event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(supabase, event.data.object as Stripe.Invoice);
        break;
      default:
        // Not one of the 5 events this app acts on -- claim it (above) so
        // we never re-inspect it, but there's nothing to apply.
        break;
    }
  } catch (err) {
    // Deliberately do NOT touch the claim row here (no delete, no status
    // change): it stays 'processing'. A future redelivery either sees it
    // still fresh (409, try again shortly) or, once STALE_CLAIM_MS has
    // passed, reclaims it via the compare-and-swap in claimStripeEvent and
    // genuinely retries the handler -- so a failure here still results in
    // the event eventually being retried, without ever risking a
    // concurrent request reading a half-finished state as "succeeded".
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`Error handling Stripe event ${event.id} (${event.type}):`, message);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  // stillOwned:false means this claim was reclaimed as stale while the
  // handler above was still running. The effect it just applied is still
  // correct (every handler here is an idempotent upsert/update by stable
  // key), so we still ack 200 rather than force a pointless retry --
  // markStripeEventSucceeded already logs this loudly for monitoring.
  await markStripeEventSucceeded(supabase, event, claimToken);
  return NextResponse.json({ received: true });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckoutSessionCompleted(
  supabase: SupabaseServiceRoleClient,
  session: Stripe.Checkout.Session,
) {
  if (session.mode !== "subscription") {
    // This app only sells subscriptions via Checkout; ignore one-off
    // payment-mode sessions if any are ever created.
    return;
  }

  const organizationId = session.client_reference_id ?? session.metadata?.organization_id;
  if (!organizationId) {
    console.error(
      `checkout.session.completed ${session.id} has no organization_id ` +
        "(client_reference_id/metadata) -- cannot link it to an organization.",
    );
    return;
  }

  const customerId = extractId(session.customer);
  const subscriptionId = extractId(session.subscription);
  if (!customerId || !subscriptionId) {
    console.error(
      `checkout.session.completed ${session.id} is missing customer/subscription id.`,
    );
    return;
  }

  // The checkout.session.completed payload doesn't carry price/period
  // details, only ids -- fetch the full Subscription object to get them.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await upsertSubscriptionRow(supabase, organizationId, subscription, customerId);
}

async function handleSubscriptionUpsert(
  supabase: SupabaseServiceRoleClient,
  subscription: Stripe.Subscription,
) {
  const customerId = extractId(subscription.customer);
  if (!customerId) {
    console.error(`Subscription event for ${subscription.id} has no customer id.`);
    return;
  }

  const organizationId = await resolveOrganizationId(
    supabase,
    subscription.metadata?.organization_id,
    customerId,
  );

  if (!organizationId) {
    console.error(
      `Could not resolve organization_id for subscription ${subscription.id} ` +
        `(customer ${customerId}) -- no metadata and no matching local row.`,
    );
    return;
  }

  await upsertSubscriptionRow(supabase, organizationId, subscription, customerId);
}

async function handleInvoicePaymentFailed(
  supabase: SupabaseServiceRoleClient,
  invoice: Stripe.Invoice,
) {
  const subscriptionId = extractId(invoice.parent?.subscription_details?.subscription ?? null);
  const customerId = extractId(invoice.customer);

  if (!subscriptionId && !customerId) {
    console.error(`invoice.payment_failed ${invoice.id} has neither subscription nor customer id.`);
    return;
  }

  const now = new Date().toISOString();
  const query = supabase.from("subscriptions").update({ last_payment_failed_at: now });

  const { data, error } = subscriptionId
    ? await query.eq("stripe_subscription_id", subscriptionId).select("id")
    : await query.eq("stripe_customer_id", customerId as string).select("id");

  if (error) {
    throw new Error(`Failed to record payment failure for invoice ${invoice.id}: ${error.message}`);
  }

  if (!data || data.length === 0) {
    // Not necessarily a bug: could be a failed invoice for a
    // subscription/customer we never saw a checkout.session.completed for
    // (e.g. test-mode noise). Logged, not thrown, so it doesn't trigger a
    // retry loop for a row that will never exist.
    console.error(
      `invoice.payment_failed ${invoice.id}: no matching subscriptions row for ` +
        `subscription=${subscriptionId ?? "n/a"} customer=${customerId ?? "n/a"}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves a Stripe id field that may be a plain id string or an expanded object. */
function extractId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * organization_id resolution order for customer.subscription.* events:
 *  1. subscription.metadata.organization_id -- set via subscription_data.metadata
 *     when the Checkout Session was created (app/actions/billing.ts), and
 *     preserved by Stripe across the subscription's lifetime.
 *  2. Fallback: look up the local subscriptions row already linked to this
 *     Stripe customer (covers e.g. a plan change made directly in the Stripe
 *     Dashboard, where metadata might not be present).
 */
async function resolveOrganizationId(
  supabase: SupabaseServiceRoleClient,
  metadataOrgId: string | undefined,
  customerId: string,
): Promise<string | null> {
  if (metadataOrgId) return metadataOrgId;

  const { data, error } = await supabase
    .from("subscriptions")
    .select("organization_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) {
    console.error(`Failed to resolve organization_id for customer ${customerId}:`, error);
    return null;
  }

  return data?.organization_id ?? null;
}

/** Pulls price id + current period bounds off the subscription's first item. */
function extractPriceAndPeriod(subscription: Stripe.Subscription) {
  // As of the pinned API version (2026-07-29.dahlia), current_period_start/end
  // live on each SubscriptionItem, not on the Subscription itself (Stripe
  // moved them in the 2025-03-31 API change to support multi-price
  // subscriptions with independently-billed items). This app only ever puts
  // one price on a subscription, so item[0] is authoritative.
  const item = subscription.items.data[0];
  return {
    priceId: item?.price?.id ?? null,
    periodStart: item ? new Date(item.current_period_start * 1000).toISOString() : null,
    periodEnd: item ? new Date(item.current_period_end * 1000).toISOString() : null,
  };
}

async function upsertSubscriptionRow(
  supabase: SupabaseServiceRoleClient,
  organizationId: string,
  subscription: Stripe.Subscription,
  customerId: string,
) {
  const { priceId, periodStart, periodEnd } = extractPriceAndPeriod(subscription);

  const { error } = await supabase.from("subscriptions").upsert(
    {
      organization_id: organizationId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId,
      status: subscription.status,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      cancel_at_period_end: subscription.cancel_at_period_end,
      trial_end: subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
    },
    { onConflict: "organization_id" },
  );

  if (error) {
    // Thrown (not logged-and-swallowed) so the caller's catch block returns
    // 500 instead of markStripeEventSucceeded -- this is a real failure to
    // apply the event's effect and Stripe should retry it.
    throw new Error(
      `Failed to upsert subscription for organization ${organizationId}: ${error.message}`,
    );
  }
}
