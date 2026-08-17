import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import "@/lib/supabase/ensure-websocket-polyfill";
import { createClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import type { Database } from "@/lib/supabase/database.types";
import { POST } from "@/app/api/webhooks/stripe/route";
import { claimStripeEvent, markStripeEventSucceeded, STALE_CLAIM_MS } from "@/lib/webhooks/idempotency";

// Integration test for the Stripe webhook route handler
// (app/api/webhooks/stripe/route.ts), run against the LOCAL Supabase
// instance (see .env.local). It does not require real Stripe API keys:
// - Signature generation/verification (generateTestHeaderString /
//   constructEvent) is pure local HMAC computation, no network call.
// - The event type used (customer.subscription.updated) is handled
//   entirely from the event payload itself; the handler never calls out to
//   the live Stripe API for it (unlike checkout.session.completed, which
//   calls stripe.subscriptions.retrieve and therefore needs a real key --
//   out of scope for an automated test without a real Stripe account).
//
// Covers the two non-negotiable properties from CLAUDE.md #4:
//   (a) a validly-signed event is processed, and redelivery of the SAME
//       event.id is a no-op (idempotency);
//   (b) a request with a missing/invalid signature is rejected before any
//       processing happens.

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!webhookSecret || !supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing STRIPE_WEBHOOK_SECRET / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Copy .env.example to .env.local (local Supabase must be running: `supabase start`).",
  );
}

const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const WEBHOOK_URL = "http://localhost:3000/api/webhooks/stripe";

function buildSubscriptionEventObject(opts: {
  eventId: string;
  organizationId: string;
  subscriptionId: string;
  customerId: string;
  status: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const subscription = {
    id: opts.subscriptionId,
    object: "subscription",
    customer: opts.customerId,
    status: opts.status,
    cancel_at_period_end: false,
    trial_end: null,
    metadata: { organization_id: opts.organizationId },
    items: {
      object: "list",
      data: [
        {
          id: "si_test_1",
          object: "subscription_item",
          price: { id: "price_test_basic", object: "price" },
          current_period_start: now,
          current_period_end: now + 30 * 24 * 60 * 60,
        },
      ],
    },
  };

  return {
    id: opts.eventId,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: now,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: "customer.subscription.updated",
    data: { object: subscription },
  };
}

function buildSubscriptionEvent(opts: {
  eventId: string;
  organizationId: string;
  subscriptionId: string;
  customerId: string;
  status: string;
}) {
  return JSON.stringify(buildSubscriptionEventObject(opts));
}

function postRequest(rawBody: string, signature: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) {
    headers["stripe-signature"] = signature;
  }
  return new NextRequest(WEBHOOK_URL, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("POST /api/webhooks/stripe", () => {
  const organizationId = randomUUID();
  const subscriptionId = `sub_test_${randomUUID()}`;
  const customerId = `cus_test_${randomUUID()}`;
  const eventId = `evt_test_${randomUUID()}`;

  beforeAll(async () => {
    // service_role bypasses RLS -- inserting directly, no auth.uid()
    // session, so the "creator becomes owner" trigger does not fire and no
    // organization_members row is created (nothing extra to clean up).
    const { error } = await supabase.from("organizations").insert({
      id: organizationId,
      name: `Webhook test org ${organizationId}`,
      slug: `webhook-test-${organizationId}`,
    });
    if (error) throw error;
  });

  afterAll(async () => {
    await supabase.from("processed_stripe_events").delete().eq("stripe_event_id", eventId);
    // Cascades to the subscriptions row (organization_id references
    // organizations(id) on delete cascade).
    await supabase.from("organizations").delete().eq("id", organizationId);
  });

  it("rejects a request with no stripe-signature header, without processing it", async () => {
    const rawBody = buildSubscriptionEvent({
      eventId: `${eventId}_no_sig`,
      organizationId,
      subscriptionId,
      customerId,
      status: "active",
    });

    const res = await POST(postRequest(rawBody, null));
    expect(res.status).toBe(400);

    const { data } = await supabase
      .from("processed_stripe_events")
      .select("stripe_event_id")
      .eq("stripe_event_id", `${eventId}_no_sig`)
      .maybeSingle();
    expect(data).toBeNull();
  });

  it("rejects a request with an invalid stripe-signature, without processing it", async () => {
    const rawBody = buildSubscriptionEvent({
      eventId: `${eventId}_bad_sig`,
      organizationId,
      subscriptionId,
      customerId,
      status: "active",
    });

    const res = await POST(postRequest(rawBody, "t=1,v1=deadbeefnotreal"));
    expect(res.status).toBe(400);

    const { data } = await supabase
      .from("processed_stripe_events")
      .select("stripe_event_id")
      .eq("stripe_event_id", `${eventId}_bad_sig`)
      .maybeSingle();
    expect(data).toBeNull();
  });

  it("processes a validly-signed event and writes the subscription to the DB", async () => {
    const rawBody = buildSubscriptionEvent({
      eventId,
      organizationId,
      subscriptionId,
      customerId,
      status: "active",
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: webhookSecret!,
    });

    const res = await POST(postRequest(rawBody, signature));
    expect(res.status).toBe(200);

    const { data: subscriptionRow, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("organization_id", organizationId)
      .single();

    expect(error).toBeNull();
    expect(subscriptionRow?.stripe_subscription_id).toBe(subscriptionId);
    expect(subscriptionRow?.stripe_customer_id).toBe(customerId);
    expect(subscriptionRow?.status).toBe("active");
    expect(subscriptionRow?.stripe_price_id).toBe("price_test_basic");

    const { data: ledgerRow } = await supabase
      .from("processed_stripe_events")
      .select("stripe_event_id, event_type")
      .eq("stripe_event_id", eventId)
      .single();
    expect(ledgerRow?.event_type).toBe("customer.subscription.updated");
  });

  it("does not re-apply a redelivered event with the same event.id (idempotency)", async () => {
    // Same event.id as the previous test, but the payload now claims a
    // different status. A correct handler must treat this purely as a
    // duplicate delivery (by event.id) and must NOT re-run the handler --
    // so the DB row must still show the ORIGINAL status ("active"), not
    // "canceled".
    const rawBody = buildSubscriptionEvent({
      eventId,
      organizationId,
      subscriptionId,
      customerId,
      status: "canceled",
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: webhookSecret!,
    });

    const res = await POST(postRequest(rawBody, signature));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);

    const { data: subscriptionRow } = await supabase
      .from("subscriptions")
      .select("status")
      .eq("organization_id", organizationId)
      .single();

    // Still "active" -- the redelivered event was a no-op, proving the
    // idempotency ledger actually prevented double-processing rather than
    // just deduplicating some unrelated side effect.
    expect(subscriptionRow?.status).toBe("active");

    const { data: ledgerRows } = await supabase
      .from("processed_stripe_events")
      .select("stripe_event_id")
      .eq("stripe_event_id", eventId);
    expect(ledgerRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: reproduces the TOCTOU race qa-reviewer found and fixed in
// lib/webhooks/idempotency.ts (see the long comment at the top of that file
// for the full story). The bug: a concurrent redelivery of the same
// event.id, arriving while the first attempt was still mid-flight, was told
// "200, duplicate, already done" purely because a claim row already
// existed -- with no guarantee the effect had actually been applied yet. If
// the first attempt then failed, the event's effect was silently lost with
// no future Stripe retry, because Stripe had already been told 200.
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/stripe -- idempotency race conditions", () => {
  const organizationId = randomUUID();

  beforeAll(async () => {
    const { error } = await supabase.from("organizations").insert({
      id: organizationId,
      name: `Webhook race test org ${organizationId}`,
      slug: `webhook-race-test-${organizationId}`,
    });
    if (error) throw error;
  });

  afterAll(async () => {
    // Cascades to any subscriptions row for this org.
    await supabase.from("organizations").delete().eq("id", organizationId);
  });

  it(
    "does not ack 200 for a concurrent redelivery while the original attempt is still " +
      "mid-flight, and correctly acks 200 once it has actually succeeded",
    async () => {
      const eventId = `evt_test_race_${randomUUID()}`;
      const subscriptionId = `sub_test_race_${randomUUID()}`;
      const customerId = `cus_test_race_${randomUUID()}`;

      const eventObject = buildSubscriptionEventObject({
        eventId,
        organizationId,
        subscriptionId,
        customerId,
        status: "active",
      });
      const rawBody = JSON.stringify(eventObject);
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: rawBody,
        secret: webhookSecret!,
      });

      // Simulate "session A" claiming the event and starting work --
      // mirrors qa-reviewer's SQL-level repro (their INSERT, held open
      // across a pg_sleep before the real handler would finish). We drive
      // this directly via claimStripeEvent instead of relying on real wall-
      // clock timing inside the route handler, so the test is deterministic
      // rather than a timing-dependent race that could pass or fail
      // depending on machine speed.
      const claim = await claimStripeEvent(supabase, eventObject as unknown as Stripe.Event);
      if (!claim.owned) {
        throw new Error("expected claimStripeEvent to return owned:true for a fresh event.id");
      }

      // While that claim is still open (status='processing', not yet
      // succeeded), a REAL concurrent redelivery hits the actual route
      // handler -- this is "session B" from the qa-reviewer repro.
      const concurrentResponse = await POST(postRequest(rawBody, signature));

      // The old buggy behavior would ack 200 here. The fix must NOT: the
      // effect (the subscriptions row) has not been applied yet, and acking
      // 200 now would tell Stripe to stop retrying an event whose effect
      // might never land if session A subsequently fails.
      expect(concurrentResponse.status).toBe(409);
      const concurrentBody = await concurrentResponse.json();
      expect(concurrentBody.received).not.toBe(true);

      // Confirm the concurrent request genuinely did not run any handler
      // logic (it must have short-circuited at the claim check, before ever
      // reaching the switch/dispatch in POST).
      const { data: midFlightSubscription } = await supabase
        .from("subscriptions")
        .select("id")
        .eq("organization_id", organizationId)
        .maybeSingle();
      expect(midFlightSubscription).toBeNull();

      // Session A finishes successfully.
      await markStripeEventSucceeded(
        supabase,
        eventObject as unknown as Stripe.Event,
        claim.claimToken,
      );
      // Apply the actual effect a real successful POST would have applied,
      // so the "now succeeded" duplicate-ack check below reflects a
      // genuinely completed event, not just a manually-flipped ledger flag.
      await supabase.from("subscriptions").upsert(
        {
          organization_id: organizationId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          status: "active",
        },
        { onConflict: "organization_id" },
      );

      // NOW a redelivery (Stripe's real retry of the request that got 409
      // above, or any other later redelivery) must get a clean 200 duplicate
      // ack -- this time correctly, because the effect really did succeed.
      const afterSuccessResponse = await POST(postRequest(rawBody, signature));
      expect(afterSuccessResponse.status).toBe(200);
      const afterSuccessBody = await afterSuccessResponse.json();
      expect(afterSuccessBody.duplicate).toBe(true);

      const { data: ledgerRows } = await supabase
        .from("processed_stripe_events")
        .select("stripe_event_id")
        .eq("stripe_event_id", eventId);
      expect(ledgerRows).toHaveLength(1);
    },
  );

  it(
    "under genuine parallel delivery of the same event.id, exactly one caller applies " +
      "the effect and the DB ends up in a single consistent state",
    async () => {
      const eventId = `evt_test_parallel_${randomUUID()}`;
      const subscriptionId = `sub_test_parallel_${randomUUID()}`;
      const customerId = `cus_test_parallel_${randomUUID()}`;

      const rawBody = buildSubscriptionEvent({
        eventId,
        organizationId,
        subscriptionId,
        customerId,
        status: "active",
      });
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: rawBody,
        secret: webhookSecret!,
      });

      // Two truly concurrent requests for the identical event.id, fired
      // without awaiting between them -- real parallelism, not simulated,
      // complementing the deterministic controlled test above.
      const [resA, resB] = await Promise.all([
        POST(postRequest(rawBody, signature)),
        POST(postRequest(rawBody, signature)),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Exactly one request must win the claim and apply the effect (200).
      // The other is either told to retry (409, if it lost the race before
      // the winner finished) or -- if it happened to check after the winner
      // had already finished -- gets a correct duplicate ack (200). Never a
      // 500, and never anything outside this pair of legitimate outcomes.
      expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
      expect(statuses).toContain(200);

      // Regardless of which request "won", the DB must end up with exactly
      // one correct subscriptions row for this event, and the ledger must
      // show exactly one row marked succeeded -- no double-application, no
      // lost update.
      const { data: subscriptionRow, error: subError } = await supabase
        .from("subscriptions")
        .select("stripe_subscription_id, stripe_customer_id, status")
        .eq("organization_id", organizationId)
        .single();
      expect(subError).toBeNull();
      expect(subscriptionRow?.stripe_subscription_id).toBe(subscriptionId);
      expect(subscriptionRow?.stripe_customer_id).toBe(customerId);
      expect(subscriptionRow?.status).toBe("active");

      const { data: ledgerRows } = await supabase
        .from("processed_stripe_events")
        .select("stripe_event_id, status")
        .eq("stripe_event_id", eventId);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows?.[0]?.status).toBe("succeeded");
    },
  );

  it(
    "fencing token: a stale-but-not-crashed claim cannot finalize after being reclaimed " +
      "-- exactly one of {original, reclaimer} ever counts as the owner",
    async () => {
      // Reproduces qa-reviewer's second SQL-level repro exactly:
      //   1. A "processing" claim's processed_at is backdated past
      //      STALE_CLAIM_MS -- simulating a request that is merely slow,
      //      not crashed (still genuinely working, about to finalize).
      //   2. A concurrent reclaim runs and succeeds (correct, by the
      //      status+staleness rule).
      //   3. The ORIGINAL request, unaware it was reclaimed, finally
      //      finishes and calls its own finalize.
      // Before the fencing token, step 3's finalize matched on
      // `status='processing'` alone and ALSO succeeded -- both the
      // original and the reclaimer believed, at different moments, that
      // they exclusively owned the claim. This test proves that no longer
      // happens: the original's finalize must now report stillOwned:false
      // (its token no longer matches), and only the reclaimer's own
      // finalize actually flips the row to 'succeeded'.
      const eventId = `evt_test_fencing_${randomUUID()}`;
      const subscriptionId = `sub_test_fencing_${randomUUID()}`;
      const customerId = `cus_test_fencing_${randomUUID()}`;

      const eventObject = buildSubscriptionEventObject({
        eventId,
        organizationId,
        subscriptionId,
        customerId,
        status: "active",
      });
      const typedEvent = eventObject as unknown as Stripe.Event;

      // Step 1: the "original" claims the event -- a normal, fresh claim.
      const originalClaim = await claimStripeEvent(supabase, typedEvent);
      if (!originalClaim.owned) {
        throw new Error("expected claimStripeEvent to return owned:true for a fresh event.id");
      }

      // Backdate processed_at past STALE_CLAIM_MS to simulate the original
      // request having been alive-but-slow for that long, WITHOUT ever
      // crashing or losing its claim token -- it still holds
      // originalClaim.claimToken and fully intends to finalize with it.
      const backdatedIso = new Date(Date.now() - STALE_CLAIM_MS - 5_000).toISOString();
      const { error: backdateError } = await supabase
        .from("processed_stripe_events")
        .update({ processed_at: backdatedIso })
        .eq("stripe_event_id", eventId)
        .eq("status", "processing");
      if (backdateError) throw backdateError;

      // Step 2: a concurrent reclaimer sees the now-stale claim and takes
      // it over -- this is legitimate per the status+staleness rule alone,
      // and must succeed.
      const reclaimerClaim = await claimStripeEvent(supabase, typedEvent);
      if (!reclaimerClaim.owned) {
        throw new Error("expected the reclaimer to successfully reclaim the stale claim");
      }
      expect(reclaimerClaim.claimToken).not.toBe(originalClaim.claimToken);

      // Step 3: the original, unaware it was reclaimed, finally finishes
      // and tries to finalize with its OLD token. This must now be
      // rejected -- the row belongs to the reclaimer.
      const originalFinalize = await markStripeEventSucceeded(
        supabase,
        typedEvent,
        originalClaim.claimToken,
      );
      expect(originalFinalize.stillOwned).toBe(false);

      // The row must NOT have been flipped to 'succeeded' by the zombie
      // original's finalize -- it should still be 'processing', owned by
      // the reclaimer (claim_token is a plain uuid column now, so this is
      // a direct equality check with no timestamp-serialization nuance).
      const { data: midStateRow } = await supabase
        .from("processed_stripe_events")
        .select("status, claim_token")
        .eq("stripe_event_id", eventId)
        .single();
      expect(midStateRow?.status).toBe("processing");
      expect(midStateRow?.claim_token).toBe(reclaimerClaim.claimToken);

      // Only the reclaimer's own finalize, with its own current token,
      // can actually succeed.
      const reclaimerFinalize = await markStripeEventSucceeded(
        supabase,
        typedEvent,
        reclaimerClaim.claimToken,
      );
      expect(reclaimerFinalize.stillOwned).toBe(true);

      const { data: finalRow } = await supabase
        .from("processed_stripe_events")
        .select("status")
        .eq("stripe_event_id", eventId)
        .single();
      expect(finalRow?.status).toBe("succeeded");
    },
  );
});
