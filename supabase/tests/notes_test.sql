-- ============================================================================
-- notes_test.sql (pgTAP)
--
-- Proves, per RLS policy defined in supabase/migrations/20260817212642_add_notes.sql:
--   - notes are isolated by organization (member of org X never sees org Y's
--     notes, and vice versa);
--   - any member can create a note, but only as themselves (author_id must
--     be their own auth.uid());
--   - a member can edit/delete their own notes but NOT another member's;
--   - an owner can edit/delete ANY note in their organization (moderation);
--   - a note's organization_id cannot be changed after creation.
--
-- Same technique as rls_isolation_test.sql Part 1: one rolled-back
-- transaction, fixtures inserted as postgres (BYPASSRLS), personas
-- simulated via request.jwt.claims + switching to the authenticated role.
-- ============================================================================

begin;
select plan(11);

-- ----------------------------------------------------------------------------
-- Fixtures
-- ----------------------------------------------------------------------------
insert into auth.users (id) values
  ('80000000-0000-0000-0000-000000000001'), -- owner_x  (owner of org X)
  ('80000000-0000-0000-0000-000000000002'), -- member_x (member of org X)
  ('80000000-0000-0000-0000-000000000003'); -- owner_y  (owner of org Y, unrelated org)

insert into public.organizations (id, name, slug) values
  ('70000000-0000-0000-0000-000000000001', 'Notes Org X', 'pgtap-notes-org-x'),
  ('70000000-0000-0000-0000-000000000002', 'Notes Org Y', 'pgtap-notes-org-y');

insert into public.organization_members (organization_id, user_id, role) values
  ('70000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'owner'),
  ('70000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000002', 'member'),
  ('70000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000003', 'owner');

insert into public.notes (id, organization_id, author_id, title, body) values
  ('90000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000002', 'Member''s note', 'written by member_x'),
  ('90000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'Owner''s note', 'written by owner_x'),
  ('90000000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000003', 'Other org''s note', 'written by owner_y, org Y');

-- ============================================================================
-- notes_select_members: isolation between organizations
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ select id from public.notes where id = '90000000-0000-0000-0000-000000000003' $$,
  'notes_select_members: a member of org X cannot see org Y''s note'
);

select results_eq(
  $$ select id from public.notes order by id $$,
  $$ values
      ('90000000-0000-0000-0000-000000000001'::uuid),
      ('90000000-0000-0000-0000-000000000002'::uuid) $$,
  'notes_select_members: a member of org X sees exactly org X''s notes (both, not just their own -- shared team content)'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ select id from public.notes
     where id in ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000002') $$,
  'notes_select_members: an owner of org Y cannot see any of org X''s notes'
);

-- ============================================================================
-- notes_insert_members_as_self
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ insert into public.notes (organization_id, author_id, title)
     values ('70000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000002', 'A new note') $$,
  'notes_insert_members_as_self: a member can create a note authored by themselves'
);

select throws_ok(
  $$ insert into public.notes (organization_id, author_id, title)
     values ('70000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'Impersonation attempt') $$,
  '42501',
  'new row violates row-level security policy for table "notes"',
  'notes_insert_members_as_self: a member cannot create a note authored by someone else'
);

-- ============================================================================
-- notes_update_author_or_owner: author-or-owner, not any member
-- ============================================================================
select lives_ok(
  $$ update public.notes set body = 'edited by its own author'
     where id = '90000000-0000-0000-0000-000000000001' $$,
  'notes_update_author_or_owner: a member can edit their own note'
);

select is_empty(
  $$ update public.notes set body = 'hijacked' where id = '90000000-0000-0000-0000-000000000002' returning id $$,
  'notes_update_author_or_owner: a member cannot edit another member''s note'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ update public.notes set body = 'moderated by the owner'
     where id = '90000000-0000-0000-0000-000000000001' $$,
  'notes_update_author_or_owner: an owner can edit any note in their organization (moderation)'
);

-- ============================================================================
-- notes_delete_author_or_owner
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ delete from public.notes where id = '90000000-0000-0000-0000-000000000002' returning id $$,
  'notes_delete_author_or_owner: a member cannot delete another member''s note'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', '80000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ delete from public.notes where id = '90000000-0000-0000-0000-000000000001' $$,
  'notes_delete_author_or_owner: an owner can delete any note in their organization (moderation)'
);

-- ============================================================================
-- trg_prevent_note_organization_change
-- ============================================================================
select throws_ok(
  $$ update public.notes set organization_id = '70000000-0000-0000-0000-000000000002'
     where id = '90000000-0000-0000-0000-000000000002' $$,
  'P0001',
  'notes.organization_id cannot be changed; delete and recreate the note in the target organization instead',
  'trg_prevent_note_organization_change: a note cannot be moved to a different organization'
);

select * from finish();
rollback;
