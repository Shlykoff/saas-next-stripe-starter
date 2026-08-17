-- ============================================================================
-- Migration: add_processed_stripe_events
-- Purpose:   Idempotency ledger for the Stripe webhook handler (CLAUDE.md
--            rule #4: every webhook must verify stripe-signature and handle
--            redelivery idempotently). Stripe redelivers events on timeout/
--            error, so the handler must check-and-record each event.id
--            before/while applying its effects, so a redelivered event is a
--            no-op instead of double-applying (e.g. re-crediting a period,
--            re-sending a receipt).
--
--            This table is written exclusively by the webhook handler
--            running with the service_role key -- never by client code, and
--            never readable by regular users, same posture as `subscriptions`.
-- ============================================================================

create table public.processed_stripe_events (
  -- Stripe's own event.id (e.g. "evt_1N..."). Primary key doubles as the
  -- idempotency guard: the handler does an INSERT for the event it's about
  -- to process, and a duplicate delivery hits a unique-violation instead of
  -- running the handler logic twice. (INSERT ... ON CONFLICT DO NOTHING is
  -- the expected pattern for stripe-specialist to use here.)
  stripe_event_id  text primary key,

  -- Stripe's event.type (e.g. "customer.subscription.updated"), kept
  -- unstructured/free-text on purpose -- new event types the webhook starts
  -- handling later shouldn't need a migration just to be logged.
  event_type       text not null,

  -- Best-effort link to the organization this event was about, nullable
  -- because it isn't always resolvable at insert time: e.g. a
  -- checkout.session.completed event may arrive before the handler has
  -- matched Stripe's customer id to a local organization_id, or an event
  -- may concern a customer/subscription that was never matched at all
  -- (bad data, test-mode noise, etc). ON DELETE SET NULL rather than
  -- CASCADE: this is an audit trail, not tenant data, and deleting an
  -- organization should not silently delete history of what Stripe sent.
  organization_id  uuid references public.organizations (id) on delete set null,

  -- Raw event payload, for debugging and manual replay/inspection when a
  -- webhook effect needs to be investigated after the fact. Trade-off
  -- considered: Stripe event payloads for this app's event types
  -- (checkout.session.completed, customer.subscription.*,
  -- invoice.payment_failed) don't carry raw card numbers/PANs (Stripe
  -- tokenizes those), but they do carry billing email, name and address --
  -- i.e. real PII. Storing it is still worth it here for debuggability
  -- (this is a service_role-only, RLS-locked table, never exposed to
  -- authenticated/anon), but stripe-specialist and qa-reviewer should
  -- treat this column as sensitive: no logging it verbatim to third-party
  -- error trackers, and it's a reasonable candidate for a retention/purge
  -- job later rather than being kept forever. Nullable so the handler can
  -- still record "we saw this event.id" even if it chooses not to persist
  -- the body for a given event type.
  payload          jsonb,

  processed_at     timestamptz not null default now()
);

comment on table public.processed_stripe_events is
  'Idempotency ledger for the Stripe webhook handler: one row per processed event.id, written only by service_role.';

create index processed_stripe_events_organization_id_idx on public.processed_stripe_events (organization_id);
create index processed_stripe_events_event_type_idx on public.processed_stripe_events (event_type);
create index processed_stripe_events_processed_at_idx on public.processed_stripe_events (processed_at);

-- ----------------------------------------------------------------------------
-- Row Level Security -- deny-by-default, service_role only, no exceptions.
-- ----------------------------------------------------------------------------
alter table public.processed_stripe_events enable row level security;
alter table public.processed_stripe_events force row level security;

-- No SELECT/INSERT/UPDATE/DELETE policy exists for `authenticated` or
-- `anon` at all -- this is an internal technical table, not tenant data;
-- even org owners should never see raw Stripe payloads for other reasons
-- than this app's own product features. service_role has BYPASSRLS so
-- these policies are not what actually grants it access (the GRANTs below
-- are), but they're declared anyway so the intent is visible directly in
-- the schema, matching the pattern used for `subscriptions`.
create policy "processed_stripe_events_select_service_role"
  on public.processed_stripe_events for select
  to service_role
  using (true);

create policy "processed_stripe_events_insert_service_role"
  on public.processed_stripe_events for insert
  to service_role
  with check (true);

create policy "processed_stripe_events_update_service_role"
  on public.processed_stripe_events for update
  to service_role
  using (true)
  with check (true);

create policy "processed_stripe_events_delete_service_role"
  on public.processed_stripe_events for delete
  to service_role
  using (true);

-- ----------------------------------------------------------------------------
-- Table-level grants -- see the equivalent comment in
-- 20260817171827_init_core_schema.sql (section 9) for why this is required
-- in addition to RLS on this project. `authenticated`/`anon` intentionally
-- get NO grant at all here -- not even SELECT -- unlike organizations/
-- organization_members/subscriptions, which grant SELECT to authenticated.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.processed_stripe_events to service_role;
