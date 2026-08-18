-- ============================================================================
-- notes_realtime_test.sql (pgTAP)
--
-- Proves, per 20260818174917_enable_notes_realtime.sql:
--   Part A -- the config is actually in place (publication membership,
--             replica identity, trigger, RLS posture on realtime.messages).
--   Part B/C/D -- the notes_broadcast_changes() trigger fires correctly on
--             INSERT/UPDATE/DELETE and writes a well-formed row to
--             realtime.messages on topic notes:org:<organization_id>,
--             *without* the SECURITY DEFINER escalation breaking or
--             over-granting anything (the acting role is always
--             `authenticated`, going through notes' own RLS, never
--             `postgres`).
--   Part E/F -- the REAL security boundary: the
--             notes_broadcast_authorized_org_members RLS policy on
--             realtime.messages actually isolates by organization, denies
--             anon entirely, safely handles a malformed/spoofed topic
--             without erroring, and a regular client cannot forge a
--             broadcast message directly.
--
-- ----------------------------------------------------------------------------
-- What this file does NOT and CANNOT prove -- read before trusting this
-- feature is "done":
-- ----------------------------------------------------------------------------
-- pgTAP runs everything as direct SQL inside one Postgres session with
-- `request.jwt.claims` faked via set_config(), the same technique used by
-- every other *_test.sql in this project. That is a faithful proxy for how
-- PostgREST (and, per Supabase's own documentation, Realtime's own
-- postgres_changes/private-channel authorization check) evaluates RLS --
-- it genuinely proves the POLICY LOGIC is correct.
--
-- It does NOT and CANNOT exercise:
--   1. The actual WebSocket protocol: whether nextjs-frontend's
--      `supabase.channel(...)` call actually attaches the signed-in user's
--      JWT to the realtime socket (via the client's built-in auth<->realtime
--      sync, or an explicit `supabase.realtime.setAuth(token)` call) is a
--      client-side JS concern with no SQL equivalent. If that wiring is
--      missing or the token is stale/expired, the subscription runs as
--      `anon` and (per this migration's Part 3 policy) gets nothing -- safe
--      by default, but a functional bug, not something pgTAP would catch,
--      and the opposite mistake (a stray privileged/service-role key ending
--      up in a client bundle) would silently defeat every policy tested
--      here and is likewise invisible to SQL-only tests.
--   2. Realtime server's own internal postgres_changes RLS re-check --
--      that logic runs inside the Elixir Realtime service (confirmed
--      present as image public.ecr.aws/supabase/realtime:v2.124.2 via
--      `docker ps`, not something this repository's migrations control or
--      pgTAP can invoke), and Supabase's own documentation for that
--      specific version is the authority on it, not a SQL assertion here.
--   3. Live channel subscribe/unsubscribe behavior, reconnect-with-stale-JWT
--      behavior, or actually receiving an event client-side and updating
--      the notes list UI -- all squarely nextjs-frontend + a real
--      supabase-js client concerns.
--
-- What nextjs-frontend must additionally verify manually / with an
-- integration test using a real Realtime client (browser or node
-- supabase-js, actual WebSocket, two real signed-in sessions from two
-- different organizations) before shipping this feature:
--   - Subscribe as a member of org A on `notes:org:<A>` (private channel,
--     `.on('broadcast', {event: '*'}, ...)` per Part 2/3 of the migration)
--     and confirm INSERT/UPDATE/DELETE on org A's notes arrive.
--   - From a second real session authenticated as a member of org B, try
--     subscribing to topic `notes:org:<A>` directly (bypassing any UI that
--     would normally only ever construct that topic from the caller's own
--     org) and confirm the subscription is refused/receives nothing -- this
--     is the live equivalent of Part E below and is the one that actually
--     matters, since it exercises the real JWT-over-websocket path.
--   - If postgres_changes is *also* used (e.g. for INSERT/UPDATE, since it
--     needs no trigger/topic wiring): confirm DELETE events are NOT relied
--     upon from that channel for anything security-sensitive -- confirm in
--     the actual running app that a DELETE performed by org A is/ isn't
--     visible to an org B postgres_changes subscriber (documented to leak
--     regardless of `filter:`; the private-broadcast channel from this
--     migration is what DELETE must be sourced from instead).
-- ============================================================================

begin;
select plan(17);

-- ============================================================================
-- Part A: structural checks
-- ============================================================================

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notes'
  ),
  'public.notes is a member of the supabase_realtime publication'
);

select is(
  (select relreplident from pg_class where oid = 'public.notes'::regclass),
  'f',
  'public.notes has REPLICA IDENTITY FULL'
);

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.notes'::regclass
      and tgname = 'trg_notes_broadcast_changes'
      and tgenabled <> 'D'
  ),
  'trg_notes_broadcast_changes is installed and enabled on public.notes'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass),
  'realtime.messages has row level security enabled (private-channel delivery is deny-by-default, not open-by-default)'
);

select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'notes_broadcast_authorized_org_members'
      and cmd = 'SELECT'
  ),
  'notes_broadcast_authorized_org_members SELECT policy exists on realtime.messages'
);

-- ----------------------------------------------------------------------------
-- Fixtures
-- ----------------------------------------------------------------------------
insert into auth.users (id) values
  ('a1000000-0000-0000-0000-000000000001'), -- owner_x  (owner of org X)
  ('a1000000-0000-0000-0000-000000000002'), -- member_x (member of org X)
  ('a1000000-0000-0000-0000-000000000003'); -- owner_y  (owner of org Y, unrelated org)

insert into public.organizations (id, name, slug) values
  ('a2000000-0000-0000-0000-000000000001', 'RT Org X', 'pgtap-rt-org-x'),
  ('a2000000-0000-0000-0000-000000000002', 'RT Org Y', 'pgtap-rt-org-y');

insert into public.organization_members (organization_id, user_id, role) values
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'owner'),
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'member'),
  ('a2000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000003', 'owner');

-- ============================================================================
-- Part B: INSERT -- broadcast trigger fires through the caller's OWN
-- RLS-gated write (authenticated role, not postgres), proving the
-- SECURITY DEFINER escalation on notes_broadcast_changes() is scoped
-- correctly (it must not require the caller to have any direct privilege
-- on realtime.messages).
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'a1000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ insert into public.notes (id, organization_id, author_id, title, body)
     values ('a3000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'RT note', 'v1') $$,
  'a member can insert a note (RLS-gated) without the broadcast trigger raising a permission error on realtime.messages'
);

set local role postgres;

select results_eq(
  $$ select event, payload->>'operation', (payload->'record'->>'id')::uuid
     from realtime.messages
     where topic = 'notes:org:a2000000-0000-0000-0000-000000000001' and event = 'INSERT' $$,
  $$ values ('INSERT'::text, 'INSERT'::text, 'a3000000-0000-0000-0000-000000000001'::uuid) $$,
  'INSERT on notes broadcasts a realtime.messages row on topic notes:org:<organization_id> carrying the new row id'
);

-- ============================================================================
-- Part C: UPDATE -- old_record is present in the broadcast payload
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'a1000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ update public.notes set body = 'v2' where id = 'a3000000-0000-0000-0000-000000000001' $$,
  'an owner can update the note (moderation) without the broadcast trigger raising an error'
);

set local role postgres;

select is(
  (
    select payload -> 'old_record' ->> 'body'
    from realtime.messages
    where topic = 'notes:org:a2000000-0000-0000-0000-000000000001' and event = 'UPDATE'
    order by inserted_at desc
    limit 1
  ),
  'v1',
  'UPDATE broadcast payload.old_record carries the pre-update value -- OLD is available to the trigger regardless of postgres_changes'' own REPLICA IDENTITY requirements'
);

-- ============================================================================
-- Part D: DELETE -- the event postgres_changes CANNOT RLS-filter at all
-- (see migration header). This is the whole point of Part 2/3 of the
-- migration: this path covers DELETE with a real per-organization
-- authorization boundary where postgres_changes structurally cannot.
-- ============================================================================
select lives_ok(
  $$ delete from public.notes where id = 'a3000000-0000-0000-0000-000000000001' $$,
  'an owner can delete the note without the broadcast trigger raising an error'
);

set local role postgres;

select results_eq(
  $$ select event, (payload -> 'old_record' ->> 'organization_id')::uuid
     from realtime.messages
     where topic = 'notes:org:a2000000-0000-0000-0000-000000000001' and event = 'DELETE' $$,
  $$ values ('DELETE'::text, 'a2000000-0000-0000-0000-000000000001'::uuid) $$,
  'DELETE on notes broadcasts a realtime.messages row with old_record.organization_id intact'
);

-- ============================================================================
-- Part E: authorization -- the actual isolation boundary for who can READ
-- these broadcast rows (three notes:org:<org X> messages now exist: INSERT,
-- UPDATE, DELETE).
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'a1000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select ok(
  (select count(*) from realtime.messages where topic = 'notes:org:a2000000-0000-0000-0000-000000000001') = 3,
  'notes_broadcast_authorized_org_members: a member of org X can read all 3 of org X''s notes broadcast messages'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'a1000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ select 1 from realtime.messages where topic = 'notes:org:a2000000-0000-0000-0000-000000000001' $$,
  'notes_broadcast_authorized_org_members: an owner of unrelated org Y reads NONE of org X''s notes broadcast messages -- this is the real cross-org isolation boundary for DELETE that postgres_changes cannot provide'
);

select lives_ok(
  $$ select 1 from realtime.messages where topic = 'notes:org:not-a-uuid-spoofed' $$,
  'a malformed/spoofed topic is safely rejected by the policy''s regex guard (no cast-error raised out of the authorization check)'
);

select is_empty(
  $$ select 1 from realtime.messages where topic = 'notes:org:not-a-uuid-spoofed' $$,
  'a malformed/spoofed topic yields zero rows under the guard, not an error and not a leak'
);

-- ============================================================================
-- Part F: anon is denied entirely, and a client cannot forge a broadcast
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
set local role anon;

select is_empty(
  $$ select 1 from realtime.messages where topic = 'notes:org:a2000000-0000-0000-0000-000000000001' $$,
  'notes_broadcast_authorized_org_members: anon (unauthenticated) cannot read any notes broadcast messages -- the policy is `to authenticated` only'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'a1000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok(
  $$ insert into realtime.messages (topic, event, payload, extension)
     values ('notes:org:a2000000-0000-0000-0000-000000000001', 'INSERT', '{}'::jsonb, 'broadcast') $$,
  '42501',
  'new row violates row-level security policy for table "messages"',
  'a regular authenticated client cannot directly forge a notes:org:* broadcast message into realtime.messages -- writes only ever happen through the SECURITY DEFINER trigger'
);

select * from finish();
rollback;
