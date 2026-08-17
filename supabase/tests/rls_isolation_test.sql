-- ============================================================================
-- rls_isolation_test.sql (pgTAP)
--
-- Proves, per RLS policy defined in
-- supabase/migrations/20260817171827_init_core_schema.sql, that a user in
-- one organization cannot see/mutate another organization's data, and that
-- role (owner vs member) is enforced where it matters.
--
-- Run with:
--   supabase test db
--
-- Technique for the RLS assertions (Part 1 below): everything runs inside
-- one transaction (rolled back at the end). Fixtures are inserted as
-- `postgres` (BYPASSRLS). Each persona is then simulated by setting
-- `request.jwt.claims` (what PostgREST normally sets from the caller's
-- JWT) and switching to the `authenticated` role, exactly what auth.uid()
-- reads in application code.
--
-- Part 2 (bottom of file) is a genuine concurrency regression test for the
-- last-owner race condition and deliberately does NOT run inside that same
-- rolled-back transaction -- see its own header comment for why.
-- ============================================================================

-- dblink is used only by Part 2 to open a second, truly concurrent
-- connection back to this same database. It has no effect on the schema
-- under test and is not part of the application migration.
create extension if not exists dblink;

select plan(26);

begin;

-- ----------------------------------------------------------------------------
-- Fixtures (as postgres, bypasses RLS)
-- ----------------------------------------------------------------------------
insert into auth.users (id) values
  ('20000000-0000-0000-0000-000000000001'), -- owner_a   (owner of org A)
  ('20000000-0000-0000-0000-000000000002'), -- member_a  (member of org A)
  ('20000000-0000-0000-0000-000000000003'), -- extra_a   (second member of org A)
  ('20000000-0000-0000-0000-000000000004'), -- owner_b   (owner of org B, sole owner)
  ('20000000-0000-0000-0000-000000000005'); -- newcomer  (has no org yet)

insert into public.organizations (id, name, slug) values
  ('10000000-0000-0000-0000-000000000001', 'PGTAP Org A', 'pgtap-org-a'),
  ('10000000-0000-0000-0000-000000000002', 'PGTAP Org B', 'pgtap-org-b');

insert into public.organization_members (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'owner'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'member'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'member'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000004', 'owner');

insert into public.subscriptions (organization_id, stripe_customer_id, status, current_period_end)
values ('10000000-0000-0000-0000-000000000001', 'cus_pgtap_a', 'active', now() + interval '30 days');
-- Org B intentionally has no subscription row: exercises "never checked out" state.

-- ============================================================================
-- organizations_select_members
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select results_eq(
  $$ select id from public.organizations order by id $$,
  $$ values ('10000000-0000-0000-0000-000000000001'::uuid) $$,
  'organizations_select_members: owner_a sees only org A, never org B'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000004', 'role', 'authenticated')::text, true);
set local role authenticated;

select results_eq(
  $$ select id from public.organizations order by id $$,
  $$ values ('10000000-0000-0000-0000-000000000002'::uuid) $$,
  'organizations_select_members: owner_b sees only org B, never org A'
);

-- ============================================================================
-- organizations_insert_authenticated + bootstrap-owner trigger
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000005', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ insert into public.organizations (id, name, slug) values ('10000000-0000-0000-0000-000000000009', 'Bootstrap Org', 'pgtap-bootstrap') $$,
  'organizations_insert_authenticated: any authenticated user can create a new organization'
);

select results_eq(
  $$ select role from public.organization_members
     where organization_id = '10000000-0000-0000-0000-000000000009'
       and user_id = '20000000-0000-0000-0000-000000000005' $$,
  $$ values ('owner'::text) $$,
  'trg_new_organization_owner: creator of a new org is automatically its owner'
);

-- ============================================================================
-- organizations_update_owner
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ update public.organizations set name = 'PGTAP Org A Renamed' where id = '10000000-0000-0000-0000-000000000001' $$,
  'organizations_update_owner: owner can rename their own organization'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ update public.organizations set name = 'Hacked By Member' where id = '10000000-0000-0000-0000-000000000001' returning id $$,
  'organizations_update_owner: a non-owner member cannot rename the organization'
);

-- ============================================================================
-- organizations_delete_owner
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000004', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ delete from public.organizations where id = '10000000-0000-0000-0000-000000000001' returning id $$,
  'organizations_delete_owner: a user from a different organization cannot delete org A'
);

-- ============================================================================
-- organization_members_select_same_org
-- ============================================================================
select is_empty(
  $$ select 1 from public.organization_members where organization_id = '10000000-0000-0000-0000-000000000001' $$,
  'organization_members_select_same_org: owner_b sees none of org A''s member roster'
);

-- ============================================================================
-- organization_members_insert_owner
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok(
  $$ insert into public.organization_members (organization_id, user_id, role)
     values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'member') $$,
  '42501',
  'new row violates row-level security policy for table "organization_members"',
  'organization_members_insert_owner: a non-owner member cannot invite new members'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ insert into public.organization_members (organization_id, user_id, role)
     values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'member') $$,
  'organization_members_insert_owner: an owner can invite new members'
);

-- ============================================================================
-- organization_members_update_owner
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ update public.organization_members set role = 'owner'
     where organization_id = '10000000-0000-0000-0000-000000000001'
       and user_id = '20000000-0000-0000-0000-000000000003'
     returning id $$,
  'organization_members_update_owner: a non-owner cannot change another member''s role'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ update public.organization_members set role = 'owner'
     where organization_id = '10000000-0000-0000-0000-000000000001'
       and user_id = '20000000-0000-0000-0000-000000000003' $$,
  'organization_members_update_owner: an owner can promote a member (org A now has 2 owners)'
);

-- ============================================================================
-- trg_prevent_member_user_id_change: membership rows cannot be reassigned to
-- another user via UPDATE (still acting as owner_a, who is otherwise fully
-- permitted to UPDATE this row per organization_members_update_owner).
-- ============================================================================
select throws_ok(
  $$ update public.organization_members set user_id = '20000000-0000-0000-0000-000000000005'
     where organization_id = '10000000-0000-0000-0000-000000000001'
       and user_id = '20000000-0000-0000-0000-000000000003' $$,
  'P0001',
  'organization_members.user_id cannot be changed; remove and re-invite instead',
  'trg_prevent_member_user_id_change: an owner cannot reassign a membership row to a different user_id'
);

select lives_ok(
  $$ update public.organization_members set role = 'member'
     where organization_id = '10000000-0000-0000-0000-000000000001'
       and user_id = '20000000-0000-0000-0000-000000000003' $$,
  'trg_prevent_member_user_id_change: an owner can still update role alone (user_id unchanged) after the guard is in place'
);

-- ============================================================================
-- organization_members_delete_owner_or_self
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ delete from public.organization_members
     where organization_id = '10000000-0000-0000-0000-000000000001'
       and user_id = '20000000-0000-0000-0000-000000000003'
     returning id $$,
  'organization_members_delete_owner_or_self: a member cannot remove a different member'
);

select lives_ok(
  $$ delete from public.organization_members
     where organization_id = '10000000-0000-0000-0000-000000000001'
       and user_id = '20000000-0000-0000-0000-000000000002' $$,
  'organization_members_delete_owner_or_self: a member can remove themselves (leave org)'
);

-- ============================================================================
-- subscriptions_select_members
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000004', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ select 1 from public.subscriptions where organization_id = '10000000-0000-0000-0000-000000000001' $$,
  'subscriptions_select_members: a user outside org A cannot see its subscription row'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select results_eq(
  $$ select status from public.subscriptions where organization_id = '10000000-0000-0000-0000-000000000001' $$,
  $$ values ('active'::text) $$,
  'subscriptions_select_members: an org owner can see their own org''s subscription status'
);

-- ============================================================================
-- subscriptions writes: service_role only, never a regular authenticated user
-- (no INSERT/UPDATE/DELETE grant exists for `authenticated` at all)
-- ============================================================================
select throws_ok(
  $$ insert into public.subscriptions (organization_id, status) values ('10000000-0000-0000-0000-000000000002', 'active') $$,
  '42501',
  'permission denied for table subscriptions',
  'subscriptions: an authenticated user cannot self-grant a subscription via INSERT'
);

select throws_ok(
  $$ update public.subscriptions set status = 'active' where organization_id = '10000000-0000-0000-0000-000000000001' $$,
  '42501',
  'permission denied for table subscriptions',
  'subscriptions: an authenticated user cannot edit subscription status via UPDATE'
);

select throws_ok(
  $$ delete from public.subscriptions where organization_id = '10000000-0000-0000-0000-000000000001' $$,
  '42501',
  'permission denied for table subscriptions',
  'subscriptions: an authenticated user cannot DELETE a subscription row'
);

-- Positive control: service_role (the Stripe webhook handler's role) can
-- write, proving the restriction above is about role, not a broken table.
set local role postgres;
set local role service_role;

select lives_ok(
  $$ update public.subscriptions set status = 'past_due' where organization_id = '10000000-0000-0000-0000-000000000001' $$,
  'subscriptions_update_service_role: service_role (webhook handler) can update subscription status'
);

-- ============================================================================
-- prevent_last_owner_change trigger, exercised through the owner-or-self
-- DELETE policy: RLS would allow owner_b to delete themselves (self), but
-- the trigger must still block it because they are org B's only owner.
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-0000-0000-000000000004', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok(
  $$ delete from public.organization_members
     where organization_id = '10000000-0000-0000-0000-000000000002'
       and user_id = '20000000-0000-0000-0000-000000000004' $$,
  'P0001',
  'Cannot remove the last owner of an organization',
  'prevent_last_owner_change: the sole owner of an organization cannot remove themselves'
);

rollback;

-- ============================================================================
-- Part 2: prevent_last_owner_change RACE CONDITION regression test
--
-- Background: qa-reviewer found that the original version of the trigger
-- (a plain `SELECT count(*) ... WHERE role = 'owner' AND id <> old.id`) is
-- not safe under concurrent transactions on READ COMMITTED. Two sessions
-- each removing a *different* owner of the same 2-owner org could each run
-- their count while the other's DELETE was still uncommitted, each see "1
-- other owner still there", both pass, both commit -> organization left
-- with zero owners and no legal path back in (every admin policy requires
-- is_org_owner()). Fixed by taking `pg_advisory_xact_lock(hashtext(org_id))`
-- before counting, which serializes owner-removal per organization for the
-- lifetime of the transaction.
--
-- Why this can't be tested inside Part 1's single rolled-back transaction:
-- a lock only blocks a genuinely SEPARATE transaction. Everything inside
-- one BEGIN...ROLLBACK is the same transaction/snapshot, so there is no way
-- to create the actual race from in there. This section therefore uses
-- dblink to open a second, real connection back to this same database --
-- a truly independent backend/transaction -- and deliberately uses REAL
-- COMMITs (not rollback) so that connection can actually see this session's
-- writes, exactly like the two sessions in qa-reviewer's live repro. Since
-- nothing here gets rolled back automatically, fixtures are cleaned up
-- explicitly at the end instead.
-- ============================================================================

do $$ begin raise notice '--- Part 2: last-owner race condition regression test ---'; end $$;

-- Fixtures for this section, committed for real so the second (dblink)
-- connection can actually see them.
begin;

insert into auth.users (id) values
  ('50000000-0000-0000-0000-000000000001'), -- race_owner_1
  ('50000000-0000-0000-0000-000000000002'); -- race_owner_2

insert into public.organizations (id, name, slug) values
  ('60000000-0000-0000-0000-000000000001', 'Race Org', 'pgtap-race-org');

insert into public.organization_members (organization_id, user_id, role) values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'owner'),
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 'owner');

commit;

-- "Session A": start a real transaction and remove race_owner_1. Per the
-- fix, this acquires and HOLDS the advisory lock for this org until this
-- transaction ends (commit, below).
begin;

delete from public.organization_members
where organization_id = '60000000-0000-0000-0000-000000000001'
  and user_id = '50000000-0000-0000-0000-000000000001';

-- "Session B": a genuinely separate connection/transaction, connecting back
-- to this same server. inet_server_addr()/inet_server_port() are used
-- instead of a hardcoded host so this works regardless of which container
-- network address this test happens to be running under.
select dblink_connect(
  'race_conn',
  format(
    'host=%s port=%s dbname=%s user=postgres password=postgres sslmode=disable',
    inet_server_addr(), inet_server_port(), current_database()
  )
);

-- Fire session B's removal of the OTHER owner asynchronously, so session A
-- (this session) can keep running and check on it without waiting for it.
select dblink_send_query('race_conn', $q$
  delete from public.organization_members
  where organization_id = '60000000-0000-0000-0000-000000000001'
    and user_id = '50000000-0000-0000-0000-000000000002'
$q$);

select pg_sleep(0.3);

-- THE KEY ASSERTION: while session A's transaction (holding the advisory
-- lock) is still open, session B's concurrent owner-removal must still be
-- BLOCKED, not silently completed. This is what closes the race: before the
-- fix, both sessions' counts would have already run and passed by now.
select ok(
  dblink_is_busy('race_conn') = 1,
  'race condition fix: a concurrent owner-removal on the same org blocks instead of running past the check while session A is still open'
);

-- Release session A's lock. Session B can now proceed -- but it will
-- re-count against A's now-committed result (race_owner_1 gone), see zero
-- remaining owners, and correctly fail.
commit;

select pg_sleep(0.3);

-- `ok()` must be called as a top-level SELECT for its returned TAP line to
-- actually reach psql's output (and from there, pg_prove) -- calling it via
-- PERFORM inside a DO block runs the assertion but silently discards the
-- return value, which desyncs the plan count without ever showing up as a
-- failure. So: capture session B's outcome into a temp table procedurally,
-- then assert on it with a plain top-level select.
create temp table race_b_result (errored boolean, errmsg text);

do $$
declare
  b_errored boolean := false;
  b_errmsg  text := null;
begin
  begin
    perform dblink_get_result('race_conn');
  exception when others then
    b_errored := true;
    b_errmsg := sqlerrm;
  end;

  insert into race_b_result (errored, errmsg) values (b_errored, b_errmsg);
end $$;

select ok(
  (select errored and errmsg = 'Cannot remove the last owner of an organization' from race_b_result),
  'race condition fix: once serialized, session B correctly fails to remove the last remaining owner (no silent double-removal)'
);

select is(
  (
    select count(*)::int from public.organization_members
    where organization_id = '60000000-0000-0000-0000-000000000001'
      and role = 'owner'
  ),
  1,
  'race condition fix: the organization still has exactly one owner after both concurrent removal attempts resolve'
);

select dblink_disconnect('race_conn');
drop table race_b_result;

-- Cleanup: this section committed for real, so undo it explicitly. The
-- guard trigger is briefly disabled purely so cleanup can remove the last
-- owner row too -- it is re-enabled immediately after.
alter table public.organization_members disable trigger trg_prevent_last_owner_change;
delete from public.organization_members where organization_id = '60000000-0000-0000-0000-000000000001';
alter table public.organization_members enable trigger trg_prevent_last_owner_change;
delete from public.organizations where id = '60000000-0000-0000-0000-000000000001';
delete from auth.users where id in (
  '50000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000002'
);

select * from finish();
