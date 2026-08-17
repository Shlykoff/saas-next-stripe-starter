-- ============================================================================
-- Migration: init_core_schema
-- Purpose:   Foundational multi-tenant schema for the SaaS starter.
--            organizations + organization_members (roles) + subscriptions
--            (Stripe status mirror). Every user-data table gets RLS,
--            deny-by-default, with explicit per-operation policies.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Extensions
-- ----------------------------------------------------------------------------
-- Note: gen_random_uuid(), used as the default for every id column below, is
-- built into Postgres core since PG13 and does NOT need pgcrypto for that.
-- We still enable pgcrypto here for crypt()/gen_salt(), which supabase/seed.sql
-- uses to hash the local test users' passwords into auth.users -- it's
-- already enabled on this project, but asserted explicitly so the migration
-- is self-contained / portable to the hosted project.
create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- 1. organizations
-- ----------------------------------------------------------------------------
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) > 0),
  -- URL-friendly identifier, used for workspace routing (/org/<slug>).
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.organizations is
  'One row per tenant/workspace. All tenant-scoped tables hang off organization_id.';

-- ----------------------------------------------------------------------------
-- 2. organization_members
-- ----------------------------------------------------------------------------
-- Junction table between auth.users and organizations, carrying the role.
-- Minimum two roles: 'owner' (full control, billing, membership management)
-- and 'member' (regular access to the product, no billing/membership rights).
create table public.organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- Deleting an auth.users row cascades here. If that user is the SOLE
  -- owner of an organization, this cascade delete hits trg_prevent_last_owner_change
  -- (below) and the whole DELETE FROM auth.users fails with an exception --
  -- by design, so an organization can never silently end up ownerless via
  -- account deletion. Whoever builds the "delete my account" UI/flow
  -- (nextjs-frontend) needs to handle this: check for sole ownership first
  -- and require the user to transfer ownership or delete the organization
  -- before their account can be deleted.
  user_id          uuid not null references auth.users (id) on delete cascade,
  role             text not null check (role in ('owner', 'member')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);

comment on table public.organization_members is
  'Membership + role of a user inside an organization. Drives all multi-tenant RLS checks.';

create index organization_members_user_id_idx on public.organization_members (user_id);
create index organization_members_org_id_idx on public.organization_members (organization_id);

-- ----------------------------------------------------------------------------
-- 3. subscriptions
-- ----------------------------------------------------------------------------
-- One Stripe subscription mirrored per organization (1:1). Written exclusively
-- by the Stripe webhook handler running with the service_role key on the
-- server; never written directly by an authenticated end user (see RLS below)
-- so nobody can grant themselves an active subscription client-side.
create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null unique references public.organizations (id) on delete cascade,

  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  stripe_price_id        text,

  -- Mirrors Stripe's subscription.status values. Null = no subscription yet
  -- (organization created but never went through Checkout).
  status                 text check (
                            status is null or status in (
                              'trialing', 'active', 'past_due', 'canceled',
                              'unpaid', 'incomplete', 'incomplete_expired', 'paused'
                            )
                          ),

  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  trial_end              timestamptz,

  -- Set from invoice.payment_failed to drive a "please update billing" banner
  -- in the UI without needing a separate events table for the MVP.
  last_payment_failed_at timestamptz,

  -- Escape hatch for whatever extra fields the webhook handler ends up
  -- needing (e.g. raw latest_invoice id) without another migration.
  metadata               jsonb not null default '{}'::jsonb,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.subscriptions is
  'Local mirror of one Stripe subscription per organization. Written only by the service_role webhook handler.';

create index subscriptions_status_idx on public.subscriptions (status);

-- ----------------------------------------------------------------------------
-- 4. updated_at maintenance
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.organization_members
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. Helper functions for RLS
-- ----------------------------------------------------------------------------
-- These are SECURITY DEFINER, owned by `postgres` (which has BYPASSRLS), so
-- the membership lookup inside them does NOT get re-filtered by
-- organization_members' own RLS policies. Without this, a policy on
-- organization_members that queries organization_members to check "am I a
-- member" would have its helper subquery itself gated by the same policy it
-- is trying to evaluate -- confusing at best, and slower at worst since every
-- row-check would re-run full policy evaluation instead of one indexed
-- lookup. This is the standard Supabase pattern for tenant-isolation RLS.
create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_org_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_owner(target_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_org_id
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.is_org_owner(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;
grant execute on function public.is_org_owner(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. Bootstrap trigger: creator of an organization becomes its first owner
-- ----------------------------------------------------------------------------
-- Client flow: authenticated user INSERTs into organizations (allowed by
-- policy below), and this trigger immediately inserts the matching owner
-- row into organization_members on their behalf. This avoids ever needing a
-- client-writable "insert yourself as owner of any org" policy on
-- organization_members, which would be a privilege-escalation hole.
--
-- Guarded by `auth.uid() is not null` so that admin/seed scripts running as
-- the `postgres` role (no JWT, auth.uid() = null) can insert organizations
-- directly and manage membership rows themselves.
create or replace function public.handle_new_organization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into public.organization_members (organization_id, user_id, role)
    values (new.id, auth.uid(), 'owner');
  end if;
  return new;
end;
$$;

create trigger trg_new_organization_owner
  after insert on public.organizations
  for each row execute function public.handle_new_organization();

-- ----------------------------------------------------------------------------
-- 7. Safety trigger: an organization can never be left without an owner
-- ----------------------------------------------------------------------------
create or replace function public.prevent_last_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining_owners integer;
begin
  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then

    -- Serialize the "count remaining owners" check per organization.
    --
    -- Without this, two concurrent transactions each removing a different
    -- owner of the SAME org both run under READ COMMITTED, which re-reads a
    -- fresh snapshot per statement but does not lock the *absence* of rows.
    -- Both counts can see "1 other owner still there" at the same time (each
    -- sees the other's still-uncommitted owner row), both pass the check,
    -- both commit, and the organization ends up with zero owners even
    -- though each check individually looked correct at the time it ran.
    -- This was reproduced live in review: two sessions deleting the two
    -- owners of a 2-owner org concurrently both succeeded.
    --
    -- pg_advisory_xact_lock is a transaction-scoped exclusive lock keyed by
    -- an arbitrary bigint. Taking it here, keyed by organization_id, forces
    -- every owner-removing DELETE/UPDATE on the same organization to run
    -- one at a time: the second transaction blocks on this line until the
    -- first commits or rolls back, and only then proceeds to COUNT(*) --
    -- at which point it sees the first transaction's committed result, not
    -- a stale/concurrent snapshot. That closes the race completely (it is
    -- not a probability reduction: the lock is held for the rest of the
    -- transaction, i.e. until COMMIT, so there is no window left in which
    -- a second remover can read a pre-commit state). The lock is released
    -- automatically at transaction end, no explicit unlock needed.
    --
    -- hashtext() collapses the uuid to an int4 (auto-widened to the bigint
    -- pg_advisory_xact_lock expects). A hash collision between two
    -- *different* organization_ids would only cause unrelated orgs to
    -- briefly contend for the same lock (a harmless performance hiccup),
    -- never an incorrect result -- correctness here comes from always
    -- locking the same key for a given organization_id, not from the keys
    -- being collision-free.
    perform pg_advisory_xact_lock(hashtext(old.organization_id::text));

    select count(*) into remaining_owners
    from public.organization_members
    where organization_id = old.organization_id
      and role = 'owner'
      and id <> old.id;

    if remaining_owners = 0 then
      raise exception 'Cannot remove the last owner of an organization';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_prevent_last_owner_change
  before update or delete on public.organization_members
  for each row execute function public.prevent_last_owner_change();

-- ----------------------------------------------------------------------------
-- 7b. Safety trigger: membership rows cannot be reassigned to another user
-- ----------------------------------------------------------------------------
-- Without this, organization_members_update_owner's policy would let an
-- owner run `UPDATE organization_members SET user_id = <someone else>` on
-- an existing membership row -- silently handing that row's membership
-- (and, if role = 'owner', ownership) to an arbitrary user who never
-- consented to joining, with no invite/accept step. There is no
-- invite/accept flow in docs/spec.md for this stage, so the minimal fix is
-- to make user_id immutable after insert: to add a member you INSERT a new
-- row (that policy already requires the target user_id to exist as a real
-- auth.users row); to remove one you DELETE; `role` is the only column an
-- UPDATE may change.
--
-- Enforced with a dedicated BEFORE UPDATE trigger rather than folded into
-- the RLS UPDATE policy's WITH CHECK. WITH CHECK only has direct access to
-- the NEW row; asserting "user_id didn't change" would require a
-- self-referencing subquery back into organization_members by id to read
-- the OLD value, whose MVCC visibility mid-statement is subtle and not
-- something to depend on for a security invariant. A trigger gets OLD and
-- NEW directly, with no such ambiguity, and (unlike an RLS policy) is not
-- bypassed by BYPASSRLS roles either, so it holds even for direct
-- postgres/service_role writes, not just PostgREST-mediated ones.
create or replace function public.prevent_member_user_id_change()
returns trigger
language plpgsql
as $$
begin
  if new.user_id <> old.user_id then
    raise exception 'organization_members.user_id cannot be changed; remove and re-invite instead';
  end if;
  return new;
end;
$$;

create trigger trg_prevent_member_user_id_change
  before update on public.organization_members
  for each row execute function public.prevent_member_user_id_change();

-- ----------------------------------------------------------------------------
-- 8. Row Level Security
-- ----------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.subscriptions enable row level security;

-- Belt and suspenders: FORCE ROW LEVEL SECURITY makes RLS apply even to the
-- table owner role, in contexts where it otherwise wouldn't. In practice
-- this is a no-op on this project either way: both `postgres` (the table
-- owner here, since migrations run as `postgres`) and `service_role` have
-- the BYPASSRLS attribute (see role check in Part 1 of the migration's
-- design notes / verified via `select rolname, rolbypassrls from pg_roles`),
-- and BYPASSRLS always wins over FORCE ROW LEVEL SECURITY for any role that
-- has it -- FORCE only affects owner-but-not-BYPASSRLS scenarios, which
-- don't occur here. Declared anyway for defense-in-depth/portability: if
-- this schema is ever pushed to a database where the migration-running role
-- does NOT have BYPASSRLS, FORCE is what keeps that role subject to RLS
-- like anyone else instead of silently getting owner-level access.
alter table public.organizations force row level security;
alter table public.organization_members force row level security;
alter table public.subscriptions force row level security;

-- === organizations ==========================================================

-- Any member (owner or member) can see the organizations they belong to.
create policy "organizations_select_members"
  on public.organizations for select
  to authenticated
  using (public.is_org_member(id));

-- Any signed-in user can create a new organization (onboarding flow). The
-- trigger above makes them owner immediately after.
create policy "organizations_insert_authenticated"
  on public.organizations for insert
  to authenticated
  with check (auth.uid() is not null);

-- Only an owner can rename/change the slug of their organization.
create policy "organizations_update_owner"
  on public.organizations for update
  to authenticated
  using (public.is_org_owner(id))
  with check (public.is_org_owner(id));

-- Only an owner can delete (dissolve) the organization.
create policy "organizations_delete_owner"
  on public.organizations for delete
  to authenticated
  using (public.is_org_owner(id));

-- === organization_members ===================================================

-- Owners and members can see the full member list of their own organization
-- (needed to render a "team" page); nobody sees another org's roster.
create policy "organization_members_select_same_org"
  on public.organization_members for select
  to authenticated
  using (public.is_org_member(organization_id));

-- Only an owner can invite/add new members. (First-owner bootstrap goes
-- through the SECURITY DEFINER trigger, not this policy.)
create policy "organization_members_insert_owner"
  on public.organization_members for insert
  to authenticated
  with check (public.is_org_owner(organization_id));

-- Only an owner can change a member's role (e.g. promote to owner). This
-- policy governs WHO can update a row; trg_prevent_member_user_id_change
-- (above) governs WHAT they can change -- role only, never user_id.
create policy "organization_members_update_owner"
  on public.organization_members for update
  to authenticated
  using (public.is_org_owner(organization_id))
  with check (public.is_org_owner(organization_id));

-- An owner can remove any member; any member can remove themselves (leave).
create policy "organization_members_delete_owner_or_self"
  on public.organization_members for delete
  to authenticated
  using (public.is_org_owner(organization_id) or user_id = auth.uid());

-- === subscriptions ==========================================================

-- Owners and members can read their own organization's subscription status
-- (needed for gating the product feature + rendering billing status).
create policy "subscriptions_select_members"
  on public.subscriptions for select
  to authenticated
  using (public.is_org_member(organization_id));

-- No INSERT/UPDATE/DELETE policy is granted to `authenticated` or `anon` at
-- all: subscription status is only ever written by the Stripe webhook
-- handler, which runs server-side with the service_role key. service_role
-- has BYPASSRLS and is therefore unaffected by RLS regardless of policies
-- existing for it, but we still declare explicit service_role policies
-- below so the *intent* ("only service_role writes here") is visible
-- directly in the schema and survives even if BYPASSRLS were ever revoked.
create policy "subscriptions_insert_service_role"
  on public.subscriptions for insert
  to service_role
  with check (true);

create policy "subscriptions_update_service_role"
  on public.subscriptions for update
  to service_role
  using (true)
  with check (true);

create policy "subscriptions_delete_service_role"
  on public.subscriptions for delete
  to service_role
  using (true);

-- ----------------------------------------------------------------------------
-- 9. Table-level grants
-- ----------------------------------------------------------------------------
-- RLS policies only restrict rows; PostgREST/API access also requires the
-- underlying table-level GRANT. On this project `auto_expose_new_tables` is
-- OFF (current Supabase default), so tables created by migrations (running
-- as `postgres`) are NOT auto-granted to anon/authenticated/service_role.
-- We grant only what each policy set above actually allows for
-- `authenticated`; `anon` gets nothing on any of these tables (no anonymous
-- access to tenant data). `service_role` is granted explicitly too, even
-- though BYPASSRLS makes it implicit in most managed setups, for clarity and
-- portability to the hosted project.
grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;
grant select on public.subscriptions to authenticated;

grant select, insert, update, delete on public.organizations to service_role;
grant select, insert, update, delete on public.organization_members to service_role;
grant select, insert, update, delete on public.subscriptions to service_role;
