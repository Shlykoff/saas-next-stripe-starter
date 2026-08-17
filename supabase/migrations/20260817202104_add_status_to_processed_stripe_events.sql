-- ============================================================================
-- Migration: add_status_to_processed_stripe_events
-- Purpose:   stripe-specialist hit a race in webhook idempotency (two
--            redeliveries of the same event.id both passing the "not yet
--            processed" check before either finished applying its effects)
--            and fixed it with a processing/succeeded state machine. Her
--            first pass overloaded the existing `payload` column (jsonb)
--            with `{status, event}` to carry that state, which mixes two
--            unrelated contracts into one column (payload is documented as
--            "raw Stripe event body for debugging", not a status field).
--
--            This migration gives status its own column so `payload` can
--            go back to meaning exactly what it always said it meant: the
--            raw event body, nothing else. stripe-specialist still owns
--            updating lib/webhooks/idempotency.ts to read/write `status`
--            directly and stop reading/writing payload->>'status' -- this
--            migration only adds the column.
-- ============================================================================

alter table public.processed_stripe_events
  add column status text not null default 'processing'
    check (status in ('processing', 'succeeded'));

comment on column public.processed_stripe_events.status is
  'Idempotency state machine for the webhook handler: ''processing'' is written first (e.g. via INSERT ... ON CONFLICT DO NOTHING) to claim an event.id before doing any work, then flipped to ''succeeded'' once the handler''s effects have been fully applied. A redelivery that finds an existing ''processing'' row (not yet ''succeeded'') is the in-flight/crashed-handler case for the caller to decide how to handle -- not this migration''s concern.';

comment on column public.processed_stripe_events.payload is
  'Raw Stripe event payload (event.data / full event body), for debugging and manual replay. Not a status field -- see the separate `status` column for that.';

-- No RLS/GRANT changes needed: both are declared at table level on
-- processed_stripe_events (service_role only, see
-- 20260817184409_add_processed_stripe_events.sql) and apply to this new
-- column automatically, same as every other column on the table.
