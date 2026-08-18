-- ============================================================================
-- Migration: add_organization_invites
-- Purpose:   Email-invite flow for adding a NEW OR EXISTING user to an
--            organization. Owner creates a pending invite row here ->
--            nextjs-frontend emails a link containing `token` (Resend,
--            not this migration's concern) -> invitee follows the link,
--            signs up/logs in if needed, then ACCEPTS the invite.
--
--            Acceptance itself (status -> 'accepted', accepted_at,
--            accepted_by, PLUS the resulting INSERT into
--            organization_members) is explicitly OUT OF SCOPE here: it must
--            run server-side with the service_role key, after the app has
--            checked that the invite's `email` matches the currently
--            authenticated user's email and that the invite is still
--            pending/unexpired. That is business logic, not a schema
--            concern, and belongs to nextjs-frontend. This migration's job
--            is to make sure a regular `authenticated` session (i.e. RLS)
--            has NO path to accept an invite on its own -- see the UPDATE
--            policy below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. organization_invites
-- ----------------------------------------------------------------------------
create table public.organization_invites (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  -- Normalized to lowercase via CHECK rather than a generated column: the
  -- column the app actually inserts into and reads back IS `email`, so a
  -- generated column would need a second "raw_email" source column just to
  -- feed it, which the requested shape doesn't have. A CHECK enforces the
  -- invariant "this column is always lowercase" for every writer
  -- (authenticated owner via RLS, and service_role) without adding a column
  -- -- same style already used for organizations.slug's format CHECK in
  -- 20260817171827_init_core_schema.sql. The tradeoff: callers must
  -- lower-case the email themselves before INSERT (nextjs-frontend: use
  -- `.toLowerCase()` / `lower($1)` when building the insert), since a CHECK
  -- only rejects bad input, it does not rewrite it. This matters because
  -- the one-pending-invite-per-email constraint below is a plain unique
  -- index on (organization_id, email) -- if 'Owner@x.com' and 'owner@x.com'
  -- could coexist as two different strings, that constraint would silently
  -- fail to catch the duplicate invite it exists to prevent.
  email            text not null check (
                     email = lower(email)
                     and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
                   ),

  -- Role the invitee will be granted in organization_members once accepted.
  role             text not null default 'member' check (role in ('owner', 'member')),

  -- Who sent the invite. No ON DELETE action (default RESTRICT/NO ACTION),
  -- same choice as notes.author_id: deleting an inviter's account while
  -- their sent invites still exist fails loudly instead of silently
  -- orphaning the audit trail of who invited whom. nextjs-frontend's
  -- account-deletion flow needs to account for this, same as it already
  -- must for notes.author_id and the sole-owner case on
  -- organization_members.
  invited_by       uuid not null references auth.users (id),

  -- Opaque value that goes in the invite link (/invite/accept?token=...).
  -- Deliberately separate from `id`: `id` is this row's internal identifier
  -- and may end up referenced elsewhere/logged; using it as the public,
  -- emailed, guessable-by-position link token would couple an internal key
  -- to something handed to an outside inbox. `token` can be
  -- rotated/reissued independently of `id` if that's ever needed.
  token            uuid not null unique default gen_random_uuid(),

  status           text not null default 'pending' check (
                     status in ('pending', 'accepted', 'revoked', 'expired')
                   ),

  expires_at       timestamptz not null default (now() + interval '7 days'),
  created_at       timestamptz not null default now(),

  -- Set only by the service_role acceptance flow (nextjs-frontend). Left
  -- nullable/unset for the entire 'pending' lifetime of a row.
  accepted_at      timestamptz,
  accepted_by      uuid references auth.users (id)
);

comment on table public.organization_invites is
  'Pending/accepted/revoked/expired email invites to join an organization. Row creation + revoke go through owner RLS; acceptance (status -> accepted + accepted_at/accepted_by + the resulting organization_members insert) is service_role-only application logic, not RLS.';

create index organization_invites_organization_id_idx on public.organization_invites (organization_id);
create index organization_invites_invited_by_idx on public.organization_invites (invited_by);

-- At most one PENDING invite per (organization, email) at a time. Partial
-- (status = 'pending') rather than a plain unique constraint on
-- (organization_id, email): history should be allowed to accumulate --
-- e.g. a revoked or expired invite followed by a fresh one to the same
-- address later is a normal, expected re-invite, not a duplicate.
create unique index organization_invites_org_email_pending_idx
  on public.organization_invites (organization_id, email)
  where status = 'pending';

comment on index public.organization_invites_org_email_pending_idx is
  'Prevents a second concurrent pending invite to the same email in the same organization; does not restrict revoked/expired/accepted history.';

-- ----------------------------------------------------------------------------
-- 2. Safety trigger: identity fields are immutable after creation
-- ----------------------------------------------------------------------------
-- Same "immutable identity, re-create instead of mutate" philosophy already
-- used for organization_members.user_id and notes.organization_id in this
-- schema. organization_id/email/role/token/invited_by/created_at describe
-- WHAT was invited, BY WHOM, and WHERE THE LINK POINTS -- none of that
-- should ever change after the row exists; to correct any of it, revoke and
-- send a new invite. The only columns any UPDATE (owner-revoke OR the
-- service_role acceptance flow) may legitimately touch are status,
-- expires_at, accepted_at, accepted_by.
--
-- This runs regardless of RLS/BYPASSRLS (triggers, unlike RLS policies, are
-- not skipped for roles with BYPASSRLS), so it also constrains what the
-- service_role acceptance code in nextjs-frontend is allowed to change --
-- by design, since accepting an invite should never rewrite who it was for.
create or replace function public.prevent_invite_identity_change()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id <> old.organization_id
     or new.email <> old.email
     or new.role <> old.role
     or new.token <> old.token
     or new.invited_by <> old.invited_by
     or new.created_at <> old.created_at then
    raise exception 'organization_invites: organization_id, email, role, token, invited_by, and created_at are immutable after creation; revoke and create a new invite instead';
  end if;
  return new;
end;
$$;

create trigger trg_prevent_invite_identity_change
  before update on public.organization_invites
  for each row execute function public.prevent_invite_identity_change();

-- ----------------------------------------------------------------------------
-- 3. Row Level Security -- deny-by-default
-- ----------------------------------------------------------------------------
alter table public.organization_invites enable row level security;
alter table public.organization_invites force row level security;

-- Only an owner can see their organization's invite list (who's been
-- invited, at what status) -- not a member-visible roster like
-- organization_members.
create policy "organization_invites_select_owner"
  on public.organization_invites for select
  to authenticated
  using (public.is_org_owner(organization_id));

-- Only an owner can create an invite for their own organization, and only
-- ever recording THEMSELVES as invited_by -- same "cannot act as someone
-- else" shape as notes.author_id = auth.uid() -- otherwise an owner could
-- forge invited_by to implicate a co-owner for an invite they never sent.
create policy "organization_invites_insert_owner"
  on public.organization_invites for insert
  to authenticated
  with check (
    public.is_org_owner(organization_id)
    and invited_by = auth.uid()
  );

-- Only an owner can UPDATE, and ONLY to revoke a still-pending invite
-- (pending -> revoked). This is deliberately narrow, not a general "owner
-- can edit any field" policy:
--   - USING requires the CURRENT row to be 'pending' -- an owner cannot
--     touch an already-accepted/revoked/expired row at all (re-create a
--     fresh invite instead, per the immutability trigger above).
--   - WITH CHECK requires the RESULTING row to be exactly 'revoked', with
--     accepted_at/accepted_by still null. This is what makes it structurally
--     impossible for an owner (an ordinary `authenticated` session, subject
--     to RLS) to self-accept an invite by flipping status to 'accepted' --
--     'accepted' is simply not a value this policy's WITH CHECK permits.
--     Acceptance can only happen via service_role, which bypasses RLS
--     entirely and is governed instead by trg_prevent_invite_identity_change
--     above plus nextjs-frontend's own email-match business logic.
create policy "organization_invites_update_owner_revoke"
  on public.organization_invites for update
  to authenticated
  using (
    public.is_org_owner(organization_id)
    and status = 'pending'
  )
  with check (
    public.is_org_owner(organization_id)
    and status = 'revoked'
    and accepted_at is null
    and accepted_by is null
  );

-- An owner can delete any invite belonging to their organization (cleanup).
create policy "organization_invites_delete_owner"
  on public.organization_invites for delete
  to authenticated
  using (public.is_org_owner(organization_id));

-- Explicit service_role policies, same rationale as subscriptions' in
-- 20260817171827_init_core_schema.sql: service_role has BYPASSRLS and would
-- be unaffected by RLS either way, but declaring these makes the intent
-- ("the acceptance flow writes here as service_role, not as the invitee's
-- own authenticated session") visible directly in the schema.
create policy "organization_invites_select_service_role"
  on public.organization_invites for select
  to service_role
  using (true);

create policy "organization_invites_insert_service_role"
  on public.organization_invites for insert
  to service_role
  with check (true);

create policy "organization_invites_update_service_role"
  on public.organization_invites for update
  to service_role
  using (true)
  with check (true);

create policy "organization_invites_delete_service_role"
  on public.organization_invites for delete
  to service_role
  using (true);

-- ----------------------------------------------------------------------------
-- 4. Table-level grants -- see section 9 of
--    20260817171827_init_core_schema.sql for why this is required in
--    addition to RLS on this project (auto_expose_new_tables is off).
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.organization_invites to authenticated;
grant select, insert, update, delete on public.organization_invites to service_role;
