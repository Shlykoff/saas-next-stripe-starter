-- ============================================================================
-- Migration: add_claim_token_to_processed_stripe_events
-- Purpose:   stripe-specialist's reclaim mechanism for stuck 'processing'
--            idempotency rows (e.g. handler crashed mid-webhook) needs a
--            fencing token: whoever reclaims a stale row writes a fresh
--            token, so a handler that was merely slow (not actually dead)
--            can detect on completion that it's no longer the current
--            claimant and back off instead of double-applying its effects.
--
--            The first version reused `processed_at` (a plain timestamp)
--            to also carry that fencing value. qa-reviewer confirmed no
--            collisions in practice, but both she and stripe-specialist
--            flagged the same shape of problem already fixed once on this
--            table for `payload`/`status`: overloading a human-facing,
--            editable column (someone touching processed_at by hand in
--            Studio to fix up a timestamp) with a concurrency-critical
--            value silently breaks a live claim with no error, no
--            constraint to catch it. Splitting it out closes that hole.
-- ============================================================================

alter table public.processed_stripe_events
  add column claim_token uuid not null default gen_random_uuid();

comment on column public.processed_stripe_events.claim_token is
  'Fencing token for the processing/succeeded reclaim mechanism: reclaiming a stale ''processing'' row means writing a new claim_token along with the reclaim, so the original (slow-but-not-actually-dead) handler can compare its own remembered token against the current one on completion and detect it has been superseded. Kept as its own uuid column -- not reused from processed_at or payload -- specifically so an incidental edit to those (e.g. a timestamp fixed up by hand in Studio) can never silently invalidate or collide with a live claim.';

-- No RLS/GRANT changes needed: both are declared at table level on
-- processed_stripe_events (service_role only, see
-- 20260817184409_add_processed_stripe_events.sql) and apply to this new
-- column automatically, same as `status` before it.
