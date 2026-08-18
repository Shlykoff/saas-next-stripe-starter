-- ============================================================================
-- Migration: add_note_attachments
-- Purpose:   Let organization members attach files to a note (docs/spec.md
--            item 7 follow-on). Two things need protecting here, same
--            concern as every other table in this schema:
--              1. public.note_attachments -- the file's METADATA row.
--              2. storage.objects (bucket "note-attachments") -- the actual
--                 file bytes, which is a *separate* Postgres table owned by
--                 Supabase Storage, with its own RLS, that this migration
--                 also has to gate. Metadata-only RLS with an open bucket
--                 would let anyone who can guess/enumerate a storage path
--                 download the file directly via the Storage API, bypassing
--                 note_attachments entirely -- so both halves are locked
--                 down below, independently, to the same organization
--                 boundary.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Storage bucket
-- ----------------------------------------------------------------------------
-- Private bucket (public = false): every read goes through either a
-- server-issued signed URL or an authenticated request subject to the
-- storage.objects RLS policies in section 5 below -- never a bare public URL.
--
-- file_size_limit = 10485760 bytes = 10 MiB. Chosen deliberately, not
-- copied from config.toml's local-dev default (50 MiB, meant for arbitrary
-- local testing, not a product limit): 10 MiB comfortably fits the
-- documents/spreadsheets/images this bucket's allowed_mime_types are meant
-- for, while keeping a single free-tier Supabase Storage project (1 GB on
-- the plan this repo targets per docs/spec.md) from being exhausted by a
-- handful of oversized uploads. THIS NUMBER MUST BE MIRRORED by
-- nextjs-frontend in a TS config constant (e.g.
-- lib/config/attachments.ts -> MAX_ATTACHMENT_SIZE_BYTES = 10_485_760) so
-- the client can reject an oversized file before spending an upload
-- round-trip, instead of only discovering the limit from a storage API
-- error after the bytes are already sent. Flagging this explicitly per the
-- task brief -- nextjs-frontend, please pick this up.
--
-- allowed_mime_types: common images, PDF, plain text/CSV, and the Office
-- doc/spreadsheet formats named in the brief. Deliberately EXCLUDES:
--   - image/svg+xml: an SVG is not just raster pixels, it's an XML document
--     that can embed <script> and event-handler attributes. If it is ever
--     served back same-tab from a signed URL (rather than force-downloaded)
--     a browser will happily execute that script in the origin serving it --
--     a stored-XSS vector via file upload. Convert to PNG client/server-side
--     if vector upload is ever genuinely needed; don't add this MIME type
--     back without also solving that.
--   - text/html and application/xhtml+xml: same stored-XSS risk as SVG, via
--     an even more direct route (a <script> tag needs no special markup).
--     There is no legitimate "attach an HTML file to a note" use case here
--     that isn't better served by a PDF export.
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'note-attachments',
  'note-attachments',
  false,
  10485760,
  array[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/msword',                                                      -- .doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', -- .docx
    'application/vnd.ms-excel',                                                -- .xls
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'        -- .xlsx
  ]
);

-- ----------------------------------------------------------------------------
-- 2. note_attachments -- file metadata
-- ----------------------------------------------------------------------------
create table public.note_attachments (
  id               uuid primary key default gen_random_uuid(),

  -- An attachment is meaningless without its note: cascade.
  note_id          uuid not null references public.notes (id) on delete cascade,

  -- Denormalized copy of notes.organization_id, same rationale as every
  -- other tenant-scoped table in this schema: RLS policies below read this
  -- column directly rather than joining out to notes on every row check
  -- (cheaper, and lets an index on this column alone drive the policy).
  -- Kept honest against notes.organization_id by the trigger in section 3 --
  -- RLS's WITH CHECK alone cannot verify a FK'd row's value from a
  -- different table, only this row's own columns.
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  -- No ON DELETE action specified (defaults to NO ACTION/RESTRICT), same
  -- rationale as notes.author_id: deleting a user shouldn't silently
  -- cascade-delete their uploaded files' metadata (or leave the underlying
  -- storage.objects row orphaned with no metadata pointing at it). Deleting
  -- an auth.users row that uploaded any attachment will fail with an FK
  -- violation until those attachments are reassigned/deleted first --
  -- nextjs-frontend needs to handle this the same way as the existing
  -- account-deletion cases already flagged on notes.author_id and
  -- organization_members.user_id.
  uploaded_by      uuid not null references auth.users (id),

  -- Path inside the note-attachments bucket. Unique because it 1:1
  -- identifies a storage.objects row; see section 5's header comment for
  -- the exact path convention nextjs-frontend must construct paths with.
  storage_path     text not null unique,

  -- Original filename, kept separately from storage_path for display --
  -- storage_path is sanitized/prefixed with a uuid to avoid collisions,
  -- file_name is what the user actually named the file and should see in
  -- the UI.
  file_name        text not null,
  content_type     text,
  size_bytes       bigint,

  created_at       timestamptz not null default now()
);

comment on table public.note_attachments is
  'Metadata for files attached to a note. The file bytes live in storage.objects, bucket note-attachments -- see this migration''s header comment for why both are RLS-gated independently.';

create index note_attachments_note_id_idx on public.note_attachments (note_id);
create index note_attachments_organization_id_idx on public.note_attachments (organization_id);

-- ----------------------------------------------------------------------------
-- 3. Cross-tenant integrity trigger
-- ----------------------------------------------------------------------------
-- RLS's INSERT ... WITH CHECK can only evaluate columns on the NEW row
-- itself -- it has no built-in way to verify that note_attachments.
-- organization_id actually matches the organization the referenced note_id
-- really belongs to. Without this trigger: a member of org A could INSERT a
-- note_attachments row with organization_id = A (passes the RLS insert
-- check below, since they genuinely ARE a member of A) but note_id pointing
-- at a note that actually belongs to org B -- planting cross-tenant data
-- that would then be readable by every member of org A under a note_id
-- foreign key that, if ever joined back to notes without care, points
-- somewhere its own organization_id disagrees with.
--
-- This directly mirrors trg_prevent_note_organization_change on notes
-- itself (20260817212642_add_notes.sql) -- same family of hole (RLS checks
-- a row's own columns, not cross-row/cross-table consistency), same fix
-- shape (a trigger that raises before the inconsistent row can land).
--
-- SECURITY DEFINER is required, not incidental: the inserting session's own
-- RLS visibility into public.notes may not extend to the referenced note at
-- all if it belongs to another organization (notes_select_members denies
-- it). A SECURITY DEFINER function, owned by postgres (BYPASSRLS), reads
-- the note's REAL organization_id regardless of the caller's own
-- visibility -- which is exactly what's needed to catch this attack: an
-- attacker deliberately targeting a note_id they cannot see is the whole
-- point of the check, so the check cannot itself be gated by that same
-- visibility.
create or replace function public.note_attachment_organization_matches_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  note_org_id uuid;
begin
  select organization_id into note_org_id
  from public.notes
  where id = new.note_id;

  if not found then
    raise exception 'note_attachments.note_id % does not reference an existing note', new.note_id;
  end if;

  if note_org_id <> new.organization_id then
    raise exception 'note_attachments.organization_id (%) does not match the organization of the referenced note (%)', new.organization_id, note_org_id;
  end if;

  return new;
end;
$$;

create trigger trg_note_attachment_organization_matches_note
  before insert on public.note_attachments
  for each row execute function public.note_attachment_organization_matches_note();

-- ----------------------------------------------------------------------------
-- 4. Row Level Security -- public.note_attachments
-- ----------------------------------------------------------------------------
alter table public.note_attachments enable row level security;
alter table public.note_attachments force row level security;

-- Any member (owner or member) of the organization can see all of that
-- organization's attachments -- same "shared team content" posture as
-- notes_select_members.
create policy "note_attachments_select_members"
  on public.note_attachments for select
  to authenticated
  using (public.is_org_member(organization_id));

-- Any member can attach a file, but only recording themselves as the
-- uploader -- mirrors notes_insert_members_as_self. The cross-tenant
-- consistency between organization_id and note_id is NOT re-checked here
-- (WITH CHECK can't do that reliably, see section 3) -- it's enforced by
-- trg_note_attachment_organization_matches_note above, which runs
-- regardless of which policy let the INSERT through.
create policy "note_attachments_insert_members_as_self"
  on public.note_attachments for insert
  to authenticated
  with check (
    public.is_org_member(organization_id)
    and uploaded_by = auth.uid()
  );

-- Deliberately NO UPDATE POLICY: attachments are immutable metadata --
-- re-uploading a file is a delete + insert of a new row, not an edit of an
-- existing one (the underlying storage object is immutable-by-convention
-- too, see section 5). With RLS enabled+forced and no UPDATE policy for
-- any role, every UPDATE is denied by default -- there is nothing an
-- explicit `for update using (false)` policy would add here, it would only
-- restate what "no policy" already means.

-- Uploader can delete their own attachment; an org owner can delete any
-- attachment in their organization (moderation) -- mirrors
-- notes_delete_author_or_owner.
create policy "note_attachments_delete_uploader_or_owner"
  on public.note_attachments for delete
  to authenticated
  using (
    public.is_org_member(organization_id)
    and (uploaded_by = auth.uid() or public.is_org_owner(organization_id))
  );

-- ----------------------------------------------------------------------------
-- Table-level grants -- see section 9 of 20260817171827_init_core_schema.sql
-- for why this is required in addition to RLS on this project. UPDATE is
-- intentionally NOT granted, matching "no UPDATE policy" above -- even if a
-- policy were mistakenly added later, no grant means PostgREST/API-level
-- UPDATE is still refused before RLS is ever evaluated, a second
-- independent layer against attachment mutation.
-- ----------------------------------------------------------------------------
grant select, insert, delete on public.note_attachments to authenticated;
grant select, insert, delete on public.note_attachments to service_role;

-- ----------------------------------------------------------------------------
-- 5. Row Level Security -- storage.objects, bucket "note-attachments"
-- ----------------------------------------------------------------------------
-- Path convention (nextjs-frontend MUST construct upload paths exactly this
-- way, the policies below depend on it structurally, not just by
-- convention):
--
--   {organization_id}/{note_id}/{uuid}-{sanitized_filename}
--
-- storage.foldername(name) splits the object's full path on '/' and
-- returns everything except the last segment (the filename itself) as a
-- text[], so for the path above:
--   (storage.foldername(name))[1] = organization_id
--   (storage.foldername(name))[2] = note_id
--
-- The {uuid}- prefix on the filename segment (not enforced by these
-- policies, an application-layer convention) avoids collisions between two
-- uploads of a same-named file to the same note.
--
-- Note on local-stack quirks (checked against
-- 20260818174917_enable_notes_realtime.sql, the existing precedent for
-- writing RLS on a Supabase-managed schema, realtime.messages there,
-- storage.objects here): unlike realtime.messages, storage.objects and
-- storage.buckets already ship on this local stack with row level security
-- ENABLED and ZERO policies (confirmed directly against this project's
-- local instance: `select relrowsecurity, relforcerowsecurity from
-- pg_class ... relname in ('objects','buckets')` -> rowsecurity = true,
-- forcerowsecurity = false; `select * from pg_policies where
-- schemaname='storage'` -> no rows). Deny-by-default already holds before
-- this migration runs. FORCE is not set (and this migration does not set
-- it): storage.objects/buckets are owned by supabase_storage_admin, not
-- postgres, and forcing would only matter for a BYPASSRLS-less table-owner
-- session anyway (see the FORCE ROW LEVEL SECURITY comment in
-- 20260817171827_init_core_schema.sql for the same reasoning applied to
-- this project's own tables) -- not something to change on a schema this
-- migration doesn't own. Also confirmed: authenticated/anon/service_role
-- already hold full table-level GRANTs on storage.objects (installed by
-- Supabase's own storage-schema migrations), so -- same as
-- realtime.messages -- no additional GRANT statement is needed here, RLS
-- alone is the gate.
create policy "note_attachments_storage_select_members"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'note-attachments'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy "note_attachments_storage_insert_members"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'note-attachments'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

-- IMPORTANT naming-collision note for future readers: storage.objects.owner
-- is Supabase Storage's OWN "which auth.uid() uploaded this object" column,
-- populated automatically by the Storage API. It has NO relation to this
-- app's own organization_members.role = 'owner' concept used elsewhere in
-- this schema (is_org_owner()) -- both are used together in the USING
-- clause immediately below, so read carefully: `owner` (bare column,
-- storage's uploader) vs `is_org_owner(...)` (this app's org-owner role).
create policy "note_attachments_storage_delete_uploader_or_org_owner"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'note-attachments'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
    and (
      owner = auth.uid()
      or public.is_org_owner(((storage.foldername(name))[1])::uuid)
    )
  );

-- No UPDATE policy on storage.objects either, for the same "attachments are
-- immutable, re-upload = delete + insert" reasoning as note_attachments
-- above -- with RLS enabled and no UPDATE policy, updates (including
-- in-place overwrite-on-upload) are denied by default.
