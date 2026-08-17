-- ============================================================================
-- seed.sql — local-only test data for verifying multi-tenant RLS isolation.
--
-- Loaded automatically by `supabase db reset` (see [db.seed] in config.toml).
-- NEVER run against the hosted/production project: it creates auth.users
-- rows directly with a known throwaway password, for local testing only.
--
-- Scenario: two organizations.
--   Org A "Acme"   — owner_a (owner), member_a (member) — has an ACTIVE subscription
--   Org B "Globex"  — owner_b (owner)                    — no subscription yet
--
-- Use these three accounts (password for all: "password123") to manually
-- verify isolation in Studio / via supabase-js:
--   owner_a@example.com  -> should see only Acme's org, members, subscription
--   member_a@example.com -> should see only Acme's org, members, subscription
--                            but must NOT be able to change roles or delete org
--   owner_b@example.com  -> should see only Globex, and NOTHING from Acme
-- ============================================================================

do $$
declare
  org_a_id     uuid := '11111111-1111-1111-1111-111111111111';
  org_b_id     uuid := '22222222-2222-2222-2222-222222222222';

  owner_a_id   uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  member_a_id  uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  owner_b_id   uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  seed_password text := crypt('password123', gen_salt('bf'));
begin
  -- --------------------------------------------------------------------------
  -- Test users (auth.users + auth.identities so email/password sign-in works)
  -- --------------------------------------------------------------------------
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    is_super_admin, created_at, updated_at, confirmation_token,
    recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', owner_a_id, 'authenticated', 'authenticated',
     'owner_a@example.com', seed_password, now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Olivia Owner (Acme)"}',
     false, now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', member_a_id, 'authenticated', 'authenticated',
     'member_a@example.com', seed_password, now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Mo Member (Acme)"}',
     false, now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', owner_b_id, 'authenticated', 'authenticated',
     'owner_b@example.com', seed_password, now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Gabe Owner (Globex)"}',
     false, now(), now(), '', '', '', '')
  on conflict (id) do nothing;

  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values
    (gen_random_uuid(), owner_a_id::text, owner_a_id,
     jsonb_build_object('sub', owner_a_id::text, 'email', 'owner_a@example.com'),
     'email', now(), now(), now()),
    (gen_random_uuid(), member_a_id::text, member_a_id,
     jsonb_build_object('sub', member_a_id::text, 'email', 'member_a@example.com'),
     'email', now(), now(), now()),
    (gen_random_uuid(), owner_b_id::text, owner_b_id,
     jsonb_build_object('sub', owner_b_id::text, 'email', 'owner_b@example.com'),
     'email', now(), now(), now())
  on conflict (provider_id, provider) do nothing;

  -- --------------------------------------------------------------------------
  -- Organizations
  -- --------------------------------------------------------------------------
  -- Inserted directly as `postgres` (no JWT / auth.uid() is null here), so the
  -- trg_new_organization_owner bootstrap trigger is a no-op by design — we
  -- assign membership explicitly below instead.
  insert into public.organizations (id, name, slug) values
    (org_a_id, 'Acme', 'acme'),
    (org_b_id, 'Globex', 'globex')
  on conflict (id) do nothing;

  -- --------------------------------------------------------------------------
  -- Membership / roles
  -- --------------------------------------------------------------------------
  insert into public.organization_members (organization_id, user_id, role) values
    (org_a_id, owner_a_id, 'owner'),
    (org_a_id, member_a_id, 'member'),
    (org_b_id, owner_b_id, 'owner')
  on conflict (organization_id, user_id) do nothing;

  -- --------------------------------------------------------------------------
  -- Subscriptions (as the Stripe webhook handler would write them)
  -- --------------------------------------------------------------------------
  -- Acme: active paid subscription -> product feature should be unlocked.
  insert into public.subscriptions (
    organization_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
    status, current_period_start, current_period_end, cancel_at_period_end
  ) values (
    org_a_id, 'cus_seed_acme', 'sub_seed_acme', 'price_seed_pro',
    'active', now(), now() + interval '30 days', false
  )
  on conflict (organization_id) do nothing;

  -- Globex: never checked out -> no subscription row at all, status is
  -- effectively "no subscription" from the app's point of view. This also
  -- exercises the "org exists with zero subscription rows" edge case.
end $$;
