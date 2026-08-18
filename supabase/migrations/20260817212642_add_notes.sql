-- ============================================================================
-- Migration: add_notes
-- Purpose:   The MVP's product feature (docs/spec.md item 7): a simple
--            shared team notes list per organization, gated behind an
--            active subscription. That gating happens server-side in
--            application code (nextjs-frontend checks subscription status
--            before rendering/serving this feature) -- it is deliberately
--            NOT duplicated here. RLS on this table only enforces
--            organization isolation and author/owner roles, same concern
--            as every other table in this schema; mixing a billing check
--            into RLS would split "is this subscription active" logic
--            across two places that could drift out of sync.
-- ============================================================================

create table public.notes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- No ON DELETE action specified (defaults to NO ACTION/RESTRICT): deleting
  -- an auth.users row that authored any note will fail with an FK violation
  -- until those notes are reassigned or deleted first. Notes are shared
  -- team content (not per-user private data), so silently cascade-deleting
  -- a whole team's notes just because the original author's account is
  -- being removed would be a product decision, not one to make implicitly
  -- in this migration -- flagging it here for nextjs-frontend, who'll need
  -- to handle this the same way as the existing sole-owner-deletion case on
  -- organization_members.user_id.
  author_id        uuid not null references auth.users (id),
  title            text not null,
  body             text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.notes is
  'Shared team notes per organization -- the MVP product feature gated by subscription status at the application layer, not in RLS.';

create index notes_organization_id_idx on public.notes (organization_id);
create index notes_author_id_idx on public.notes (author_id);

create trigger set_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Safety trigger: a note cannot be silently moved to a different organization
-- ----------------------------------------------------------------------------
-- Not explicitly requested, but the same shape of hole already closed on
-- organization_members.user_id: without this, a user who happens to be
-- owner of org A AND at least a member/author in org B could run
-- `UPDATE notes SET organization_id = <org B> WHERE ...` on one of org A's
-- notes -- the UPDATE policy's USING (checked against the OLD row, org A)
-- and WITH CHECK (checked against the NEW row, org B) would each pass
-- independently even though no single policy expression ever compares the
-- two, silently leaking org A's note content into org B. Locking
-- organization_id as immutable after insert closes that regardless of how
-- the UPDATE policy below evolves.
create or replace function public.prevent_note_organization_change()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id <> old.organization_id then
    raise exception 'notes.organization_id cannot be changed; delete and recreate the note in the target organization instead';
  end if;
  return new;
end;
$$;

create trigger trg_prevent_note_organization_change
  before update on public.notes
  for each row execute function public.prevent_note_organization_change();

-- ----------------------------------------------------------------------------
-- Row Level Security -- deny-by-default, org isolation + author/owner roles
-- only. No subscription/billing check here (see header comment).
-- ----------------------------------------------------------------------------
alter table public.notes enable row level security;
alter table public.notes force row level security;

-- Notes are shared team content, not private per-user: any member (owner or
-- member) of the organization can read all of the organization's notes.
create policy "notes_select_members"
  on public.notes for select
  to authenticated
  using (public.is_org_member(organization_id));

-- Any member can create a note, but only as themselves -- author_id must be
-- the caller's own auth.uid(), same pattern as organization_members'
-- bootstrap-owner trigger avoiding a "create a row for someone else" hole.
create policy "notes_insert_members_as_self"
  on public.notes for insert
  to authenticated
  with check (
    public.is_org_member(organization_id)
    and author_id = auth.uid()
  );

-- A member can edit their own notes; an owner can edit anyone's (moderation).
-- organization_id itself cannot change either way -- see
-- trg_prevent_note_organization_change above.
create policy "notes_update_author_or_owner"
  on public.notes for update
  to authenticated
  using (
    public.is_org_member(organization_id)
    and (author_id = auth.uid() or public.is_org_owner(organization_id))
  )
  with check (
    public.is_org_member(organization_id)
    and (author_id = auth.uid() or public.is_org_owner(organization_id))
  );

-- Same rule for delete: author can remove their own note, owner can remove
-- any note in their organization.
create policy "notes_delete_author_or_owner"
  on public.notes for delete
  to authenticated
  using (
    public.is_org_member(organization_id)
    and (author_id = auth.uid() or public.is_org_owner(organization_id))
  );

-- ----------------------------------------------------------------------------
-- Table-level grants -- see section 9 of 20260817171827_init_core_schema.sql
-- for why this is required in addition to RLS on this project.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.notes to authenticated;
grant select, insert, update, delete on public.notes to service_role;
