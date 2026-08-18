-- ============================================================================
-- note_attachments_test.sql (pgTAP)
--
-- Proves, per supabase/migrations/20260818222947_add_note_attachments.sql:
--
--   public.note_attachments
--   - trg_note_attachment_organization_matches_note: a member of org X
--     cannot plant a note_attachments row whose organization_id = X but
--     whose note_id actually belongs to org Y (or to no note at all) --
--     this must fail with the TRIGGER's own P0001 exception, not a generic
--     RLS 42501, since it's the trigger (not RLS) that catches it;
--   - SELECT isolation by organization;
--   - INSERT allowed only as yourself (uploaded_by = auth.uid());
--   - DELETE allowed for the uploader or an org owner, not any other member;
--   - there is genuinely no UPDATE path for anyone, uploader or owner alike
--     (no UPDATE policy AND no UPDATE grant -- proven via the missing-grant
--     42501, which fires before RLS is even consulted).
--
--   storage.objects (bucket "note-attachments")
--   - the same SELECT/INSERT/DELETE isolation and role rules, enforced
--     independently on the file bytes' own table, not just on
--     note_attachments' metadata -- see the migration's header comment for
--     why both halves matter.
--
-- Same technique as notes_test.sql: one rolled-back transaction, fixtures
-- inserted as postgres (BYPASSRLS -- but NOT trigger-exempt: BYPASSRLS only
-- skips RLS, ordinary BEFORE INSERT triggers like
-- trg_note_attachment_organization_matches_note still fire for every role,
-- postgres included, so all fixture attachments below are inserted with
-- organization_id/note_id already consistent), personas simulated via
-- request.jwt.claims + switching to the authenticated role.
-- ============================================================================

begin;
select plan(19);

-- ----------------------------------------------------------------------------
-- Fixtures
-- ----------------------------------------------------------------------------
insert into auth.users (id) values
  ('c1000000-0000-0000-0000-000000000001'), -- owner_x        (owner of org X)
  ('c1000000-0000-0000-0000-000000000002'), -- member_x       (member of org X)
  ('c1000000-0000-0000-0000-000000000003'), -- other_member_x (second member of org X)
  ('c1000000-0000-0000-0000-000000000004'); -- owner_y        (owner of org Y, unrelated org)

insert into public.organizations (id, name, slug) values
  ('c2000000-0000-0000-0000-000000000001', 'Attachments Org X', 'pgtap-attachments-org-x'),
  ('c2000000-0000-0000-0000-000000000002', 'Attachments Org Y', 'pgtap-attachments-org-y');

insert into public.organization_members (organization_id, user_id, role) values
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'owner'),
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'member'),
  ('c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000003', 'member'),
  ('c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000004', 'owner');

insert into public.notes (id, organization_id, author_id, title) values
  ('c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'Note in org X'),
  ('c3000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000004', 'Note in org Y');

-- att1: note_x, uploaded by member_x -- used for the "uploader deletes their
--   own attachment" test.
-- att2: note_x, uploaded by other_member_x -- used for "a different,
--   non-owner member cannot delete it" then "an org owner can (moderation)".
-- att3: note_y, uploaded by owner_y -- the org-Y control row for isolation.
insert into public.note_attachments (id, note_id, organization_id, uploaded_by, storage_path, file_name, content_type, size_bytes) values
  ('c4000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/aaaa0000-0000-0000-0000-000000000001-report.txt', 'report.txt', 'text/plain', 100),
  ('c4000000-0000-0000-0000-000000000002', 'c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000003', 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/aaaa0000-0000-0000-0000-000000000002-invoice.pdf', 'invoice.pdf', 'application/pdf', 200),
  ('c4000000-0000-0000-0000-000000000003', 'c3000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000004', 'c2000000-0000-0000-0000-000000000002/c3000000-0000-0000-0000-000000000002/aaaa0000-0000-0000-0000-000000000003-notes.csv', 'notes.csv', 'text/csv', 300);

-- ============================================================================
-- trg_note_attachment_organization_matches_note -- the most important test:
-- this must be the TRIGGER's own exception, not RLS's generic 42501.
-- ============================================================================
set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'c1000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

-- member_x IS a member of org X (organization_id below is genuinely theirs,
-- so the RLS WITH CHECK on organization_id/is_org_member passes) but
-- note_id points at org Y's note -- exactly the cross-tenant-planting
-- attack the trigger exists to close.
select throws_matching(
  $$ insert into public.note_attachments (note_id, organization_id, uploaded_by, storage_path, file_name)
     values ('c3000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000002/forged-forged.txt', 'forged.txt') $$,
  'does not match the organization of the referenced note',
  'trg_note_attachment_organization_matches_note: organization_id must match note_id''s real organization, not just be one the caller belongs to'
);

select throws_matching(
  $$ insert into public.note_attachments (note_id, organization_id, uploaded_by, storage_path, file_name)
     values ('00000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001/nonexistent/dangling-dangling.txt', 'dangling.txt') $$,
  'does not reference an existing note',
  'trg_note_attachment_organization_matches_note: a dangling/nonexistent note_id is also rejected'
);

-- ============================================================================
-- note_attachments_select_members: isolation between organizations
-- ============================================================================
select is_empty(
  $$ select id from public.note_attachments where id = 'c4000000-0000-0000-0000-000000000003' $$,
  'note_attachments_select_members: a member of org X cannot see org Y''s attachment'
);

select results_eq(
  $$ select id from public.note_attachments order by id $$,
  $$ values
      ('c4000000-0000-0000-0000-000000000001'::uuid),
      ('c4000000-0000-0000-0000-000000000002'::uuid) $$,
  'note_attachments_select_members: a member of org X sees exactly org X''s attachments'
);

-- ============================================================================
-- note_attachments_insert_members_as_self
-- ============================================================================
select lives_ok(
  $$ insert into public.note_attachments (note_id, organization_id, uploaded_by, storage_path, file_name)
     values ('c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/aaaa0000-0000-0000-0000-000000000004-newfile.txt', 'newfile.txt') $$,
  'note_attachments_insert_members_as_self: a member can attach a file, recorded as uploaded by themselves'
);

select throws_ok(
  $$ insert into public.note_attachments (note_id, organization_id, uploaded_by, storage_path, file_name)
     values ('c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/aaaa0000-0000-0000-0000-000000000005-impersonation.txt', 'impersonation.txt') $$,
  '42501',
  'new row violates row-level security policy for table "note_attachments"',
  'note_attachments_insert_members_as_self: a member cannot attach a file claimed as uploaded by someone else'
);

-- ============================================================================
-- note_attachments_delete_uploader_or_owner
-- ============================================================================
select lives_ok(
  $$ delete from public.note_attachments where id = 'c4000000-0000-0000-0000-000000000001' $$,
  'note_attachments_delete_uploader_or_owner: the uploader can delete their own attachment'
);

select is_empty(
  $$ delete from public.note_attachments where id = 'c4000000-0000-0000-0000-000000000002' returning id $$,
  'note_attachments_delete_uploader_or_owner: a different, non-owner member cannot delete someone else''s attachment'
);

-- No UPDATE grant at all on this table (see migration) -- permission denied
-- fires before RLS is even evaluated, for ANY role, uploader included.
select throws_ok(
  $$ update public.note_attachments set file_name = 'renamed' where id = 'c4000000-0000-0000-0000-000000000002' $$,
  '42501',
  'permission denied for table note_attachments',
  'note_attachments: no UPDATE path exists even for a member who could otherwise see/delete the row'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'c1000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ delete from public.note_attachments where id = 'c4000000-0000-0000-0000-000000000002' $$,
  'note_attachments_delete_uploader_or_owner: an org owner can delete any attachment in their organization (moderation)'
);

select throws_ok(
  $$ update public.note_attachments set file_name = 'renamed-by-owner' where id = 'c4000000-0000-0000-0000-000000000003' $$,
  '42501',
  'permission denied for table note_attachments',
  'note_attachments: no UPDATE path exists for an org owner either, not just ordinary members'
);

-- ============================================================================
-- storage.objects, bucket "note-attachments" -- same isolation/insert/delete
-- properties enforced independently on the file bytes' own table.
-- ============================================================================
set local role postgres;

insert into storage.objects (bucket_id, name, owner) values
  ('note-attachments', 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000001-mine.txt', 'c1000000-0000-0000-0000-000000000002'),   -- owned by member_x
  ('note-attachments', 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000002-theirs.txt', 'c1000000-0000-0000-0000-000000000003'), -- owned by other_member_x
  ('note-attachments', 'c2000000-0000-0000-0000-000000000002/c3000000-0000-0000-0000-000000000002/bbbb0000-0000-0000-0000-000000000003-orgy.txt', 'c1000000-0000-0000-0000-000000000004');    -- org Y, isolation control

select set_config('request.jwt.claims', json_build_object('sub', 'c1000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
set local role authenticated;

select is_empty(
  $$ select id from storage.objects where name = 'c2000000-0000-0000-0000-000000000002/c3000000-0000-0000-0000-000000000002/bbbb0000-0000-0000-0000-000000000003-orgy.txt' $$,
  'note_attachments_storage_select_members: a member of org X cannot see an object under org Y''s path prefix'
);

select results_eq(
  $$ select name from storage.objects where bucket_id = 'note-attachments' order by name $$,
  $$ values
      ('c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000001-mine.txt'::text),
      ('c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000002-theirs.txt'::text) $$,
  'note_attachments_storage_select_members: a member of org X sees exactly the objects under org X''s path prefix'
);

select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('note-attachments', 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000004-new.txt', 'c1000000-0000-0000-0000-000000000002') $$,
  'note_attachments_storage_insert_members: a member can insert an object under their own organization''s path prefix'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('note-attachments', 'c2000000-0000-0000-0000-000000000002/c3000000-0000-0000-0000-000000000002/bbbb0000-0000-0000-0000-000000000005-sneaky.txt', 'c1000000-0000-0000-0000-000000000002') $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'note_attachments_storage_insert_members: a member cannot insert an object under an org they do not belong to, regardless of the owner column they set'
);

-- storage.objects has its own BEFORE DELETE STATEMENT trigger
-- (storage.protect_delete(), installed by Supabase, not by this migration)
-- that raises 42501 for ANY direct DELETE unless the
-- storage.allow_delete_query GUC is set to 'true' for the session/local
-- transaction -- a guard against accidentally bypassing the Storage API's
-- own bookkeeping, orthogonal to RLS. It fires before RLS row-filtering
-- even runs, so it must be enabled here for the RLS DELETE policy itself
-- (not this unrelated guard) to be what the following tests actually
-- exercise -- in production, deletes go through the Storage API, which
-- sets this GUC itself.
set local storage.allow_delete_query = 'true';

select lives_ok(
  $$ delete from storage.objects where name = 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000001-mine.txt' $$,
  'note_attachments_storage_delete_uploader_or_org_owner: the uploader (storage.objects.owner) can delete their own object'
);

select is_empty(
  $$ delete from storage.objects where name = 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000002-theirs.txt' returning id $$,
  'note_attachments_storage_delete_uploader_or_org_owner: a different, non-owner member cannot delete someone else''s object'
);

-- Unlike public.note_attachments, storage.objects still carries its
-- original UPDATE table-level grant (installed by Supabase's own storage
-- migrations, untouched here -- see migration section 5's header comment),
-- so a disallowed UPDATE is not blocked by a missing GRANT the way it is on
-- note_attachments. With no UPDATE policy, RLS's USING clause instead
-- filters the row out of the update's target set entirely -- 0 rows
-- affected, no exception raised. Proven here via is_empty on the RETURNING
-- clause rather than throws_ok, precisely to document that this is a
-- silent-no-op denial, not an error, on this particular table.
select is_empty(
  $$ update storage.objects set metadata = '{"renamed":true}'::jsonb
     where name = 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000002-theirs.txt'
     returning id $$,
  'note_attachments_storage: no UPDATE policy means updates are silently filtered to zero rows, not an error, since the table-level UPDATE grant is untouched here'
);

set local role postgres;
select set_config('request.jwt.claims', json_build_object('sub', 'c1000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

select lives_ok(
  $$ delete from storage.objects where name = 'c2000000-0000-0000-0000-000000000001/c3000000-0000-0000-0000-000000000001/bbbb0000-0000-0000-0000-000000000002-theirs.txt' $$,
  'note_attachments_storage_delete_uploader_or_org_owner: an org owner can delete any object under their org''s path prefix (moderation), even though storage.objects.owner is someone else''s uid'
);

select * from finish();
rollback;
