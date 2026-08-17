-- ============================================================================
-- processed_stripe_events_test.sql (pgTAP)
--
-- Proves processed_stripe_events (see
-- supabase/migrations/20260817184409_add_processed_stripe_events.sql) is
-- reachable only by service_role: authenticated and anon get no access at
-- all (not even SELECT), since there is no GRANT for them on this table --
-- so these fail with a permission-denied error before RLS is even
-- evaluated, same as the subscriptions write-path tests in
-- rls_isolation_test.sql. service_role can fully read/write, proving the
-- table isn't simply broken/unreachable for everyone.
--
-- Self-contained in one rolled-back transaction: unlike the last-owner race
-- test, nothing here needs a second real connection, so no dblink/commits
-- are needed.
-- ============================================================================

begin;
select plan(13);

-- ============================================================================
-- anon: no access at all
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
set local role anon;

select throws_ok(
  $$ select 1 from public.processed_stripe_events $$,
  '42501',
  'permission denied for table processed_stripe_events',
  'processed_stripe_events: anon cannot SELECT (no grant at all, deny-by-default)'
);

-- ============================================================================
-- authenticated: no access at all either, same as anon
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok(
  $$ select 1 from public.processed_stripe_events $$,
  '42501',
  'permission denied for table processed_stripe_events',
  'processed_stripe_events: an authenticated org owner cannot SELECT'
);

select throws_ok(
  $$ insert into public.processed_stripe_events (stripe_event_id, event_type)
     values ('evt_test_forged', 'customer.subscription.updated') $$,
  '42501',
  'permission denied for table processed_stripe_events',
  'processed_stripe_events: an authenticated user cannot INSERT (cannot forge idempotency records)'
);

select throws_ok(
  $$ update public.processed_stripe_events set event_type = 'hacked' where stripe_event_id = 'evt_test_forged' $$,
  '42501',
  'permission denied for table processed_stripe_events',
  'processed_stripe_events: an authenticated user cannot UPDATE'
);

select throws_ok(
  $$ delete from public.processed_stripe_events where stripe_event_id = 'evt_test_forged' $$,
  '42501',
  'permission denied for table processed_stripe_events',
  'processed_stripe_events: an authenticated user cannot DELETE (cannot erase idempotency history)'
);

-- ============================================================================
-- service_role: full read/write, as the webhook handler needs
-- ============================================================================
set local role postgres;
set local role service_role;

select lives_ok(
  $$ insert into public.processed_stripe_events (stripe_event_id, event_type, payload)
     values ('evt_test_pgtap_1', 'customer.subscription.updated', '{"mock": true}'::jsonb) $$,
  'processed_stripe_events: service_role (webhook handler) can INSERT a new idempotency record'
);

select results_eq(
  $$ select event_type from public.processed_stripe_events where stripe_event_id = 'evt_test_pgtap_1' $$,
  $$ values ('customer.subscription.updated'::text) $$,
  'processed_stripe_events: service_role can SELECT the record it just wrote'
);

select lives_ok(
  $$ update public.processed_stripe_events set organization_id = null where stripe_event_id = 'evt_test_pgtap_1' $$,
  'processed_stripe_events: service_role can UPDATE a record'
);

select lives_ok(
  $$ delete from public.processed_stripe_events where stripe_event_id = 'evt_test_pgtap_1' $$,
  'processed_stripe_events: service_role can DELETE a record'
);

-- ============================================================================
-- status column: default value + check constraint
-- (added by 20260817202104_add_status_to_processed_stripe_events.sql)
-- ============================================================================
select lives_ok(
  $$ insert into public.processed_stripe_events (stripe_event_id, event_type)
     values ('evt_test_pgtap_status', 'checkout.session.completed') $$,
  'processed_stripe_events: INSERT without specifying status succeeds (has a default)'
);

select results_eq(
  $$ select status from public.processed_stripe_events where stripe_event_id = 'evt_test_pgtap_status' $$,
  $$ values ('processing'::text) $$,
  'processed_stripe_events.status: defaults to ''processing'' when not specified'
);

select lives_ok(
  $$ update public.processed_stripe_events set status = 'succeeded' where stripe_event_id = 'evt_test_pgtap_status' $$,
  'processed_stripe_events.status: can be flipped to ''succeeded'' once the handler''s effects are applied'
);

select throws_ok(
  $$ update public.processed_stripe_events set status = 'bogus_status' where stripe_event_id = 'evt_test_pgtap_status' $$,
  '23514',
  'new row for relation "processed_stripe_events" violates check constraint "processed_stripe_events_status_check"',
  'processed_stripe_events.status: the check constraint rejects any value outside (''processing'', ''succeeded'')'
);

select * from finish();
rollback;
