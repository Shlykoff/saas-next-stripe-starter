import "server-only";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { Json } from "@/lib/supabase/database.types";

type SupabaseServiceRoleClient = ReturnType<typeof createServiceRoleClient>;

// ---------------------------------------------------------------------------
// Idempotency claim for the Stripe webhook handler.
//
// WHY THIS EXISTS (see the bug this replaces): a first version of this claim
// used a single INSERT ... ON CONFLICT DO NOTHING into
// processed_stripe_events, and treated "insert hit a unique violation" as
// "already fully processed, ack with 200". That conflated two different
// meanings of "a row exists" -- (a) some request claimed this event.id and
// is still working on it, and (b) a request already finished applying its
// effect -- into a single bit of information the row's mere presence can't
// distinguish. Fixed by persisting an explicit `status` ('processing' |
// 'succeeded') column and making every claim decision a single atomic
// conditional write (INSERT ... ON CONFLICT DO NOTHING, or a
// compare-and-swap UPDATE ... WHERE ...) instead of a read followed by a
// separate write. See supabase/migrations/20260817202104_add_status_to_processed_stripe_events.sql.
//
// SECOND BUG, FIXED HERE (fencing token -- stale-reclaim without one): the
// status-only reclaim (`UPDATE ... WHERE status='processing' AND
// processed_at < stale_threshold`) only checked status, not who currently
// held the claim. qa-reviewer reproduced this at the SQL level:
//   1. A "processing" row's processed_at is backdated past STALE_CLAIM_MS
//      (simulating a request that is merely slow, not crashed -- still
//      genuinely working).
//   2. A concurrent reclaim runs: `status='processing' AND processed_at <
//      now()-60s` matches, so it succeeds (correctly, by the status-only
//      rule) and takes over the claim.
//   3. The ORIGINAL request, unaware it was reclaimed, finally finishes and
//      calls its own finalize: `UPDATE ... WHERE status='processing'`. The
//      row is STILL status='processing' (the reclaim only refreshed
//      processed_at, it didn't need to change status) -- so this ALSO
//      matches and succeeds, flipping status to 'succeeded'.
//   4. The reclaimer's own eventual finalize then matches nothing (status
//      is already 'succeeded') and silently no-ops.
// Net effect: both the original and the reclaimer believed, at different
// moments, that they exclusively owned the claim -- real double execution
// of the handler, not just a bookkeeping glitch.
//
// THE FIX: a fencing token, `claim_token` (see
// supabase/migrations/20260817205330_add_claim_token_to_processed_stripe_events.sql,
// db-architect). Every claim (fresh insert OR reclaim) stamps a new,
// randomly-generated token as part of establishing ownership. Both
// markStripeEventSucceeded (finalize) and assertStillOwnsClaim must match
// that exact token, not just status='processing' -- so once a reclaim
// writes a NEW token, the original's finalize (still carrying the OLD
// token it captured back at claim time) can no longer match the row, and
// correctly discovers it lost ownership instead of blindly succeeding.
//
// `claim_token` is its own dedicated uuid column rather than piggybacked on
// `processed_at` or `payload` -- an earlier version of this module reused
// `processed_at` (comparing timestamps for exact equality) specifically to
// avoid a schema change, which was provably correct but fragile: a human
// editing that timestamp by hand (e.g. in Supabase Studio, to fix up
// something unrelated) could silently invalidate or collide with a live
// claim, with no constraint to catch it. A dedicated column removes that
// hazard entirely and is self-documenting.
// ---------------------------------------------------------------------------

/**
 * How long a claim can sit in 'processing' before a later request is allowed
 * to treat it as abandoned (crashed process, dropped connection, etc.) and
 * reclaim it. Every handler in this app does at most a couple of DB round
 * trips plus, for checkout.session.completed, one Stripe API call -- all of
 * which complete in low single-digit seconds even under load. 60s is
 * generously above any realistic legitimate processing time (so a genuinely
 * still-in-flight request is never wrongly reclaimed, which would reopen a
 * real double-processing race) while still being far shorter than Stripe's
 * own webhook retry backoff, so recovery from a crashed claim is bounded and
 * fast relative to when Stripe would retry anyway.
 */
export const STALE_CLAIM_MS = 60_000;

type ClaimStatus = "processing" | "succeeded";

/** Fencing token for the processing/succeeded reclaim mechanism -- see processed_stripe_events.claim_token. */
export type ClaimToken = string;

export type ClaimResult =
  | { owned: true; claimToken: ClaimToken }
  | { owned: false; alreadySucceeded: boolean };

/** Best-effort organization_id for the ledger row, straight from the event payload (no DB round trip). */
function bestEffortOrganizationId(event: Stripe.Event): string | null {
  const obj = event.data.object as {
    client_reference_id?: string | null;
    metadata?: { organization_id?: string } | null;
  };
  return obj.client_reference_id ?? obj.metadata?.organization_id ?? null;
}

/**
 * Attempts to claim exclusive ownership of processing `event`. Returns
 * `{ owned: true, claimToken }` if this call may proceed to apply the
 * event's effect -- the token MUST be passed to `markStripeEventSucceeded`
 * (and, for a future non-idempotent handler, to `assertStillOwnsClaim`
 * before producing any external effect). Returns
 * `{ owned: false, alreadySucceeded }` otherwise -- the caller must NOT
 * apply any effect in that case.
 */
export async function claimStripeEvent(
  supabase: SupabaseServiceRoleClient,
  event: Stripe.Event,
): Promise<ClaimResult> {
  const nowIso = new Date().toISOString();
  // Stripe.Event is a plain JSON-serializable data object (no
  // functions/class instances) -- this cast is safe, not a type-safety
  // escape hatch.
  const rawPayload = event as unknown as Json;

  // --- Attempt 1: fresh claim -------------------------------------------
  // INSERT ... ON CONFLICT (stripe_event_id) DO NOTHING, expressed via
  // upsert + ignoreDuplicates. Atomic: under concurrent identical inserts,
  // Postgres guarantees exactly one wins and gets a row back in `data`; the
  // other(s) get an empty array here, never an error and never a peek at
  // the winner's row -- there is no read-then-write gap for two callers to
  // both observe "not claimed yet".
  //
  // claim_token is generated here (crypto.randomUUID(), Node's standard
  // library) rather than left to the column's `default gen_random_uuid()`
  // -- we need to know the exact value written so we can return it to the
  // caller as the fencing token without an extra round trip to read it back.
  const freshToken = randomUUID();
  const { data: inserted, error: insertError } = await supabase
    .from("processed_stripe_events")
    .upsert(
      {
        stripe_event_id: event.id,
        event_type: event.type,
        organization_id: bestEffortOrganizationId(event),
        status: "processing" satisfies ClaimStatus,
        claim_token: freshToken,
        payload: rawPayload,
        processed_at: nowIso,
      },
      { onConflict: "stripe_event_id", ignoreDuplicates: true },
    )
    .select("stripe_event_id");

  if (insertError) {
    throw new Error(`Failed to claim Stripe event ${event.id}: ${insertError.message}`);
  }

  if (inserted && inserted.length > 0) {
    return { owned: true, claimToken: freshToken };
  }

  // --- Attempt 2: reclaim a stale claim ----------------------------------
  // Someone else's row already exists. It might be genuinely mid-flight
  // right now (leave it alone), or it might be an abandoned/zombie claim --
  // a process that crashed, OR one that is simply still running past
  // STALE_CLAIM_MS (the exact scenario qa-reviewer reproduced). Either way,
  // reclaiming is allowed once stale; the fencing token (a NEW claim_token
  // written here) is what lets a zombie original later discover it no
  // longer owns the row, instead of both believing they do.
  //
  // The WHERE clause IS the compare-and-swap: it only takes effect if the
  // row is still 'processing' AND its processed_at is still older than the
  // staleness window at the moment Postgres evaluates the WHERE clause for
  // THIS statement -- a single atomic conditional write, not a separate
  // check-then-act pair of round trips. If a third caller races this same
  // reclaim at the same instant, only one UPDATE actually matches the row
  // (row-level locking serializes them): the first to commit refreshes
  // processed_at to "now", so the second one's `processed_at < staleBefore`
  // condition then evaluates against that fresh value and fails -- exactly
  // one reclaimer wins, deterministically. No prior-token check is needed
  // for THIS step: reclaim doesn't care who the old owner was, only that
  // the row is still 'processing' and still stale, which row-level locking
  // already makes race-free on its own.
  const reclaimToken = randomUUID();
  const staleBeforeIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data: reclaimed, error: reclaimError } = await supabase
    .from("processed_stripe_events")
    .update({
      event_type: event.type,
      organization_id: bestEffortOrganizationId(event),
      status: "processing" satisfies ClaimStatus,
      claim_token: reclaimToken,
      payload: rawPayload,
      processed_at: nowIso,
    })
    .eq("stripe_event_id", event.id)
    .eq("status", "processing" satisfies ClaimStatus)
    .lt("processed_at", staleBeforeIso)
    .select("stripe_event_id");

  if (reclaimError) {
    throw new Error(`Failed to reclaim stale Stripe event claim ${event.id}: ${reclaimError.message}`);
  }

  if (reclaimed && reclaimed.length > 0) {
    return { owned: true, claimToken: reclaimToken };
  }

  // --- Not owned: read current status purely to shape the HTTP response --
  // This SELECT gates no write, so it cannot itself reintroduce the race:
  // whatever it observes, we only ever ack 200 when it directly sees
  // status = 'succeeded'. If it observes 'processing' (fresh, not stale --
  // otherwise attempt 2 would have reclaimed it), the caller is told to
  // retry; worst case that read is a few milliseconds stale and the event
  // actually just succeeded, which just costs Stripe one harmless extra
  // retry that will see 'succeeded' and get a clean 200.
  const { data: existing, error: readError } = await supabase
    .from("processed_stripe_events")
    .select("status")
    .eq("stripe_event_id", event.id)
    .maybeSingle();

  if (readError) {
    throw new Error(`Failed to read Stripe event claim state ${event.id}: ${readError.message}`);
  }

  return { owned: false, alreadySucceeded: existing?.status === "succeeded" };
}

/**
 * Marks a claimed event as successfully processed. Call only after
 * `claimStripeEvent` returned `{ owned: true }`, passing back the exact
 * `claimToken` it returned.
 *
 * Returns `{ stillOwned: false }` if `claimToken` no longer matches the
 * row's current claim_token -- meaning this claim was reclaimed as stale
 * while this handler was still (slowly) running. The handler's own effect
 * was still applied and is still correct (upserts are idempotent), so the
 * caller should still ack Stripe with 200 rather than force a retry; this
 * return value exists so it gets logged/monitored, and so a future
 * non-idempotent handler has a signal to react to.
 */
export async function markStripeEventSucceeded(
  supabase: SupabaseServiceRoleClient,
  event: Stripe.Event,
  claimToken: ClaimToken,
): Promise<{ stillOwned: boolean }> {
  const { data, error } = await supabase
    .from("processed_stripe_events")
    .update({
      status: "succeeded" satisfies ClaimStatus,
      processed_at: new Date().toISOString(),
    })
    .eq("stripe_event_id", event.id)
    .eq("status", "processing" satisfies ClaimStatus)
    .eq("claim_token", claimToken)
    .select("stripe_event_id");

  if (error) {
    throw new Error(`Failed to mark Stripe event ${event.id} succeeded: ${error.message}`);
  }

  const stillOwned = Boolean(data && data.length > 0);
  if (!stillOwned) {
    // Fencing token mismatch: ownership moved to a reclaimer while this
    // handler was still running (STALE_CLAIM_MS elapsed without this
    // request crashing -- just slower than expected). Logged loudly
    // because it's a real signal STALE_CLAIM_MS may be too short relative
    // to actual handler latency, and because the reclaimer will
    // independently re-run the same handler logic -- currently harmless
    // (every handler is an idempotent upsert/update by stable key) but
    // exactly the situation a future non-idempotent side effect must not
    // be allowed to hit silently.
    console.error(
      `markStripeEventSucceeded: fencing token mismatch for event ${event.id} -- ` +
        "this claim was reclaimed by another attempt while this handler was still " +
        "running. The effect this handler applied is still correct (idempotent by " +
        "design), but ownership -- and therefore the final 'succeeded' write -- now " +
        "belongs to the reclaimer. Consider raising STALE_CLAIM_MS if this recurs.",
    );
  }
  return { stillOwned };
}

/**
 * Throws if `claimToken` is no longer the current owner of `event`'s claim.
 * Not called by any handler today (every current handler is an idempotent
 * upsert/update by stable key, so double execution is harmless) -- exported
 * for a future handler with a genuinely non-idempotent side effect (e.g.
 * sending an email) to call immediately before producing that effect.
 * Unlike `markStripeEventSucceeded` (checked only once, at the very end),
 * this lets such a handler bail out the moment it discovers its claim was
 * reclaimed, rather than only finding out afterward, once the
 * un-undoable external effect has already happened.
 */
export async function assertStillOwnsClaim(
  supabase: SupabaseServiceRoleClient,
  event: Stripe.Event,
  claimToken: ClaimToken,
): Promise<void> {
  const { data, error } = await supabase
    .from("processed_stripe_events")
    .select("stripe_event_id")
    .eq("stripe_event_id", event.id)
    .eq("status", "processing" satisfies ClaimStatus)
    .eq("claim_token", claimToken)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify claim ownership for event ${event.id}: ${error.message}`);
  }

  if (!data) {
    throw new Error(
      `Lost ownership of Stripe event ${event.id}'s claim (reclaimed by another ` +
        "attempt) -- aborting before applying further effects.",
    );
  }
}
