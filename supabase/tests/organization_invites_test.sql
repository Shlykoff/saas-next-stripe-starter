-- ============================================================================
-- organization_invites_test.sql (pgTAP)
--
-- Proves, per RLS policy defined in
-- supabase/migrations/20260818123625_add_organization_invites.sql:
--   - only an owner can list their own organization's invites (not members,
--     not owners of a different organization);
--   - only an owner can create an invite for their own organization, and
--     only ever recording themselves as invited_by;
--   - at most one PENDING invite can exist per (organization_id, email) at
--     a time, but a new one can be created once the old one is no longer
--     pending (revoked/accepted/expired);
--   - an owner's UPDATE is scoped to exactly "revoke a pending invite" --
--     they can never flip status to 'accepted' themselves, and cannot touch
--     an invite that isn't currently pending;
--   - organization_id/email/role/token/invited_by/created_at are immutable
--     after creation, for ANY writer including service_role;
--   - only an owner can delete an invite in their organization;
--   - service_role can run the acceptance flow (status -> accepted,
--     accepted_at, accepted_by) that RLS blocks for a regular owner
--     session, but is still bound by the identity-immutability trigger;
--   - anon has no access at all (no GRANT).
--
-- Same technique as notes_test.sql / rls_isolation_test.sql Part 1: one
-- rolled-back transaction, fixtures inserted as postgres (BYPASSRLS),
-- personas simulated via request.jwt.claims + switching role.
-- ============================================================================

begin;
select plan(22);

-- ----------------------------------------------------------------------------
-- Fixtures
-- ----------------------------------------------------------------------------
insert into auth.users (id) values
  ('e2000000-0000-0000-0000-000000000001'), -- owner_x  (owner of org X)
  ('e2000000-0000-0000-0000-000000000002'), -- member_x (member of org X)
  ('e2000000-0000-0000-0000-000000000003'); -- owner_y  (owner of org Y, unrelated org)

insert into public.organizations (id, name, slug) values
  ('e1000000-0000-0000-0000-000000000001', 'Invites Org X', 'pgtap-invites-org-x'),
  ('e1000000-0000-0000-0000-000000000002', 'Invites Org Y', 'pgtap-invites-org-y');

insert into public.organization_members (organization_id, user_id, role) values
  ('e1000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'owner'),
  ('e1000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002', 'member'),
  ('e1000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000003', 'owner');

insert into public.organization_invites (id, organization_id, email, invited_by, status) values
  ('e3000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'alice@example.com', 'e2000000-0000-0000-0000-000000000001', 'pending'),
  ('e3000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000001', 'bob@example.com',   'e2000000-0000-0000-0000-000000000001', 'pending'),
  ('e3000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000002', 'carol@example.com', 'e2000000-0000-0000-0000-000000000003', 'pending');

-- ============================================================================
-- organization_invites_select_owner
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select results_eq(
  $$ select id from public.organization_invites order by id $$,
  $$ values
      ('e3000000-0000-0000-0000-000000000001'::uuid),
      ('e3000000-0000-0000-0000-000000000002'::uuid) $$,
  'organization_invites_select_owner: owner_x sees exactly org X''s invites, never org Y''s'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ select id from public.organization_invites
     where id in ('e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000002') $$,
  'organization_invites_select_owner: owner_y cannot see any of org X''s invites'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ select id from public.organization_invites $$,
  'organization_invites_select_owner: a non-owner member of org X cannot see org X''s invite list at all'
);

-- ============================================================================
-- organization_invites_insert_owner
-- ============================================================================
select throws_ok(
  $$ insert into public.organization_invites (organization_id, email, invited_by)
     values ('e1000000-0000-0000-0000-000000000001', 'dave@example.com', 'e2000000-0000-0000-0000-000000000002') $$,
  '42501',
  'new row violates row-level security policy for table "organization_invites"',
  'organization_invites_insert_owner: a non-owner member cannot create an invite'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok(
  $$ insert into public.organization_invites (organization_id, email, invited_by)
     values ('e1000000-0000-0000-0000-000000000001', 'dave@example.com', 'e2000000-0000-0000-0000-000000000003') $$,
  '42501',
  'new row violates row-level security policy for table "organization_invites"',
  'organization_invites_insert_owner: an owner of a different organization cannot create an invite for org X'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok(
  $$ insert into public.organization_invites (organization_id, email, invited_by)
     values ('e1000000-0000-0000-0000-000000000001', 'dave@example.com', 'e2000000-0000-0000-0000-000000000003') $$,
  '42501',
  'new row violates row-level security policy for table "organization_invites"',
  'organization_invites_insert_owner: an owner cannot record someone else as invited_by (impersonation)'
);

select lives_ok(
  $$ insert into public.organization_invites (id, organization_id, email, invited_by)
     values ('e3000000-0000-0000-0000-000000000004', 'e1000000-0000-0000-0000-000000000001', 'dave@example.com', 'e2000000-0000-0000-0000-000000000001') $$,
  'organization_invites_insert_owner: an owner can create an invite for their own organization, as themselves'
);

-- ============================================================================
-- organization_invites_org_email_pending_idx: one pending invite per email
-- ============================================================================
select throws_ok(
  $$ insert into public.organization_invites (organization_id, email, invited_by)
     values ('e1000000-0000-0000-0000-000000000001', 'alice@example.com', 'e2000000-0000-0000-0000-000000000001') $$,
  '23505',
  null,
  'organization_invites_org_email_pending_idx: a second pending invite to the same email in the same org is rejected'
);

-- Revoking the original pending invite to alice@example.com frees the
-- address up for a genuinely new invite -- the partial index only guards
-- concurrently-pending rows, not history.
select lives_ok(
  $$ update public.organization_invites set status = 'revoked'
     where id = 'e3000000-0000-0000-0000-000000000001' $$,
  'organization_invites_update_owner_revoke: owner_x can revoke a pending invite'
);

select lives_ok(
  $$ insert into public.organization_invites (id, organization_id, email, invited_by)
     values ('e3000000-0000-0000-0000-000000000005', 'e1000000-0000-0000-0000-000000000001', 'alice@example.com', 'e2000000-0000-0000-0000-000000000001') $$,
  'organization_invites_org_email_pending_idx: a new pending invite to alice@example.com is allowed once the old one is revoked'
);

-- ============================================================================
-- organization_invites_update_owner_revoke: who can update, and to what
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ update public.organization_invites set status = 'revoked'
     where id = 'e3000000-0000-0000-0000-000000000002' returning id $$,
  'organization_invites_update_owner_revoke: a non-owner member cannot revoke an invite'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ update public.organization_invites set status = 'revoked'
     where id = 'e3000000-0000-0000-0000-000000000002' returning id $$,
  'organization_invites_update_owner_revoke: an owner of a different organization cannot revoke org X''s invite'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok(
  $$ update public.organization_invites set status = 'accepted'
     where id = 'e3000000-0000-0000-0000-000000000002' $$,
  '42501',
  'new row violates row-level security policy for table "organization_invites"',
  'organization_invites_update_owner_revoke: an owner cannot self-accept an invite (status -> accepted is not a permitted WITH CHECK outcome)'
);

select lives_ok(
  $$ update public.organization_invites set status = 'revoked'
     where id = 'e3000000-0000-0000-0000-000000000002' $$,
  'organization_invites_update_owner_revoke: an owner can revoke a pending invite in their own organization'
);

select is_empty(
  $$ update public.organization_invites set status = 'revoked'
     where id = 'e3000000-0000-0000-0000-000000000002' returning id $$,
  'organization_invites_update_owner_revoke: an owner cannot update an invite that is no longer pending (USING requires status = pending)'
);

-- ============================================================================
-- trg_prevent_invite_identity_change
-- ============================================================================
select throws_ok(
  $$ update public.organization_invites
     set organization_id = 'e1000000-0000-0000-0000-000000000002', status = 'revoked'
     where id = 'e3000000-0000-0000-0000-000000000004' $$,
  'P0001',
  'organization_invites: organization_id, email, role, token, invited_by, and created_at are immutable after creation; revoke and create a new invite instead',
  'trg_prevent_invite_identity_change: an owner cannot move an invite to a different organization, even while revoking it'
);

-- ============================================================================
-- organization_invites_delete_owner
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ delete from public.organization_invites where id = 'e3000000-0000-0000-0000-000000000002' returning id $$,
  'organization_invites_delete_owner: a non-owner member cannot delete an invite'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ delete from public.organization_invites where id = 'e3000000-0000-0000-0000-000000000002' returning id $$,
  'organization_invites_delete_owner: an owner of a different organization cannot delete org X''s invite'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'e2000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ delete from public.organization_invites where id = 'e3000000-0000-0000-0000-000000000002' $$,
  'organization_invites_delete_owner: an owner can delete an invite in their own organization'
);

-- ============================================================================
-- service_role: the acceptance flow (out of RLS reach for a regular owner
-- session, per organization_invites_update_owner_revoke above), but still
-- governed by the identity-immutability trigger regardless of role.
-- ============================================================================
set local role postgres;
set local role service_role;

select lives_ok(
  $$ update public.organization_invites
     set status = 'accepted', accepted_at = now(), accepted_by = 'e2000000-0000-0000-0000-000000000002'
     where id = 'e3000000-0000-0000-0000-000000000004' $$,
  'service_role: can run the acceptance flow (status/accepted_at/accepted_by) that RLS blocks for an owner session'
);

select throws_ok(
  $$ update public.organization_invites set email = 'someone-else@example.com'
     where id = 'e3000000-0000-0000-0000-000000000005' $$,
  'P0001',
  'organization_invites: organization_id, email, role, token, invited_by, and created_at are immutable after creation; revoke and create a new invite instead',
  'trg_prevent_invite_identity_change: even service_role cannot rewrite an invite''s email (identity fields are immutable for every writer)'
);

-- ============================================================================
-- anon: no access at all (no GRANT on this table for anon)
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
set local role anon;

select throws_ok(
  $$ select 1 from public.organization_invites $$,
  '42501',
  'permission denied for table organization_invites',
  'organization_invites: anon cannot SELECT at all (no grant, deny-by-default)'
);

select * from finish();
rollback;
