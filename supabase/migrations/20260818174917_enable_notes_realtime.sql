-- ============================================================================
-- Migration: enable_notes_realtime
-- Purpose:   Let nextjs-frontend subscribe to live INSERT/UPDATE/DELETE on
--            public.notes so the notes list updates without a manual
--            refresh, WITHOUT breaking the org isolation already enforced by
--            RLS in 20260817212642_add_notes.sql.
--
-- IMPORTANT -- researched, not assumed (local Realtime image is
-- public.ecr.aws/supabase/realtime:v2.124.2, confirmed via `docker ps`):
--
-- Postgres Changes (`supabase_realtime` publication + `.on('postgres_changes',
-- ...)`) DOES check RLS server-side per subscriber for INSERT and UPDATE --
-- this is not merely the client-side `filter:` option. Realtime holds each
-- subscriber's JWT and, for every INSERT/UPDATE row, evaluates it against
-- that table's RLS SELECT policy using that subscriber's role/claims before
-- deciding whether to deliver the event. A client subscribed with
-- `filter: organization_id=eq.<other org>` gets nothing back for orgs they
-- are not a member of, because `notes_select_members`
-- (using public.is_org_member(organization_id)) denies it server-side, the
-- same way a REST `select` would -- not because the client politely applied
-- its own filter.
--
-- BUT: Postgres Changes DELETE events are a documented exception --
-- Supabase's own docs state RLS is NOT applied to DELETE, "because there is
-- no way for Postgres to verify that a user has access to a deleted
-- record" (the row is already gone from the table by the time Realtime
-- would need to re-check it against a SELECT policy). In practice this
-- means: every DELETE on public.notes, in ANY organization, is broadcast to
-- EVERY authenticated client subscribed to postgres_changes on this table,
-- regardless of `filter:` or of RLS -- the client-supplied
-- `organization_id=eq.X` filter is not verified against caller identity, so
-- it is UX scoping, not a security boundary, specifically for this event
-- type. This is exactly the "looks safe, isn't" trap flagged in this task:
-- INSERT/UPDATE really are RLS-gated; DELETE is not, on this feature,
-- regardless of Realtime version, because it is a fundamental Postgres
-- limitation (RLS cannot evaluate a policy against a row that no longer
-- exists), not a missing config flag.
--
-- Verified directly against this project's local Realtime instance (not
-- assumed from general docs): `realtime.messages` exists with
-- row-level security ENABLED and ZERO policies defined (deny-by-default --
-- nothing is deliverable over a private channel yet), and both
-- `realtime.send(payload, event, topic, private default true)` and the
-- higher-level `realtime.broadcast_changes(...)` helper are present in this
-- database, confirming this Realtime version fully supports "Broadcast from
-- Database" + private channel Authorization (RLS on realtime.messages).
-- That IS the RLS-respecting delivery path for every event including
-- DELETE, because a trigger fires while OLD is still available -- it does
-- not depend on WAL/logical-decoding being able to reconstruct a deleted
-- row. This migration implements that alternative for DELETE-sensitive
-- correctness, in addition to (not instead of) postgres_changes, since
-- postgres_changes remains the simplest path for INSERT/UPDATE and
-- Supabase's own supabase-js realtime client is built around it.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Part 1: Postgres Changes (safe for INSERT/UPDATE, NOT safe alone for DELETE
-- -- see header comment and Part 2 below)
-- ----------------------------------------------------------------------------

-- Adding notes to the publication only makes CHANGE EVENTS available to the
-- Realtime server at all. It does not by itself grant any client visibility
-- into them -- delivery for INSERT/UPDATE still goes through
-- notes_select_members (RLS, enable+force already set in
-- 20260817212642_add_notes.sql), which is `to authenticated` only and
-- requires public.is_org_member(organization_id). An unauthenticated (anon)
-- subscriber, or an authenticated user who is not a member of the note's
-- organization, is denied by that policy exactly as it would be over REST --
-- this ALTER PUBLICATION statement does not weaken or bypass it.
alter publication supabase_realtime add table public.notes;

-- REPLICA IDENTITY FULL is required for two independent reasons, both about
-- data completeness rather than the RLS check itself:
--   1. Without it, UPDATE/DELETE change payloads only carry the primary key
--      (id) in old_record, not organization_id -- the nextjs-frontend
--      client-side `filter: organization_id=eq.X` (UX scoping, see header)
--      would not even have a column to filter DELETE events on.
--   2. Part 2's broadcast trigger below reads OLD.organization_id directly
--      from the trigger's row (always available regardless of replica
--      identity, since it's a native trigger, not logical decoding) so it
--      does not strictly need this for correctness -- but leaving replica
--      identity at DEFAULT while another consumer (future audit log,
--      another postgres_changes subscriber) expects old values is a classic
--      footgun, so setting it explicitly and once here documents the
--      decision for the whole table.
alter table public.notes replica identity full;


-- ----------------------------------------------------------------------------
-- Part 2: Broadcast from Database + private channel Authorization -- the
-- RLS-respecting path for DELETE, and the recommended mechanism overall.
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER (owned by postgres, search_path locked down) is required
-- here: the trigger fires under whatever role performed the write on notes
-- (`authenticated`, per that table's own RLS-gated policies), and that role
-- has no reason to be separately granted rights to insert into
-- realtime.messages -- broadcasting a change is a side effect of a write
-- notes' own RLS already authorized, not a distinct privilege the end user
-- should need. What IS gated per-recipient is the READ side (Part 3 below):
-- realtime.messages keeps RLS enabled, so writing a broadcast row here does
-- not by itself make it visible to anyone.
create or replace function public.notes_broadcast_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Topic is namespaced per-feature ("notes:") and scoped per-organization
  -- ("org:<uuid>") so the authorization policy in Part 3 can key off it
  -- without a lookup: coalesce(new, old) covers INSERT/UPDATE (NEW) and
  -- DELETE (OLD, NEW is null) in one expression -- organization_id is
  -- immutable after insert (trg_prevent_note_organization_change), so NEW
  -- and OLD never disagree on it for UPDATE anyway.
  perform realtime.broadcast_changes(
    'notes:org:' || coalesce(new.organization_id, old.organization_id)::text, -- topic
    tg_op,        -- event: 'INSERT' | 'UPDATE' | 'DELETE'
    tg_op,        -- operation
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return coalesce(new, old);
end;
$$;

comment on function public.notes_broadcast_changes() is
  'Publishes every notes INSERT/UPDATE/DELETE to private channel topic notes:org:<organization_id>. Unlike postgres_changes, DELETE is included here on equal footing -- the trigger has OLD available regardless of replica identity/WAL decoding, so there is no "RLS cannot check a deleted row" gap. Delivery is still gated by RLS on realtime.messages (see notes_broadcast_authorized_org_members below), not by this function.';

create trigger trg_notes_broadcast_changes
  after insert or update or delete on public.notes
  for each row execute function public.notes_broadcast_changes();


-- ----------------------------------------------------------------------------
-- Part 3: Authorization -- who may actually RECEIVE notes broadcasts.
-- ----------------------------------------------------------------------------
-- realtime.messages ships with row level security ENABLED and (confirmed by
-- inspecting the local instance) zero existing policies -- i.e.
-- deny-by-default already, same posture as every table in this project.
-- Realtime's server checks this by inserting a message and attempting to
-- read it back, ROLLED BACK, using the subscribing client's own JWT/role --
-- structurally the same per-subscriber RLS check it performs for
-- postgres_changes (see header), just against realtime.messages instead of
-- notes directly. Only a client who can actually SELECT the row is
-- authorized to receive it, so the policy below is the real security
-- boundary for private channel delivery, not the topic string a client
-- happens to subscribe to.
create policy "notes_broadcast_authorized_org_members"
  on realtime.messages
  for select
  to authenticated
  using (
    -- Guard the shape before casting, so a malformed/foreign topic (e.g.
    -- another feature's private channel, or a client-crafted string) fails
    -- this policy by returning false rather than raising an invalid-UUID
    -- error out of the authorization check.
    topic ~ '^notes:org:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and public.is_org_member(substring(topic from 11)::uuid)
  );

comment on policy "notes_broadcast_authorized_org_members" on realtime.messages is
  'Authorizes receiving notes:org:<organization_id> private-channel broadcasts to members of that organization only -- the actual security boundary nextjs-frontend must rely on for DELETE (and, for defense in depth, INSERT/UPDATE too), since postgres_changes DELETE events bypass RLS entirely (see migration header).';

-- No INSERT/UPDATE/DELETE policy is added for realtime.messages here:
-- writes only ever happen through notes_broadcast_changes() above, which is
-- SECURITY DEFINER and therefore bypasses RLS on realtime.messages already.
-- Regular authenticated/anon roles keep their existing table-level INSERT
-- grant on realtime.messages (present since the Supabase Realtime install
-- migrations, used for client-originated Broadcast/Presence elsewhere in
-- the platform) but with RLS enabled and no INSERT policy here, any such
-- direct write attempt to THIS topic namespace is still denied by
-- deny-by-default -- a client cannot forge a fake notes:org:<uuid> message
-- to spoof another organization's activity.
