# SaaS Starter

**English** | [Русский](README.ru.md)

[![CI](https://github.com/Shlykoff/saas-next-stripe-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/Shlykoff/saas-next-stripe-starter/actions/workflows/ci.yml)

**Live demo:** https://saas.shlykoff.com — seeded test accounts below ("Running locally"), test cards under "Stripe".

A subscription SaaS starter: Next.js (App Router) + Supabase (Auth/Postgres/RLS) + Stripe (Checkout, Customer Portal, Webhooks). Full spec — `docs/spec.md`; agent context — `CLAUDE.md`.

> Deployed to production (Vercel + hosted Supabase + Stripe test mode + Resend) and walked through end-to-end in a real browser: signup with email confirmation, Google OAuth, onboarding, Checkout, a plan upgrade with immediate proration, and the subscription-gated `/notes` feature.

## Screenshots

| Landing | Pricing | Dashboard |
|---|---|---|
| ![Landing page](docs/screenshots/landing.png) | ![Pricing page, current plan highlighted](docs/screenshots/pricing.png) | ![Dashboard with active subscription](docs/screenshots/dashboard.png) |

| Notes (gated feature) | Stripe Customer Portal |
|---|---|
| ![Notes CRUD](docs/screenshots/notes.png) | ![Stripe Customer Portal — plan switching](docs/screenshots/billing-portal.png) |

## Stack

Next.js 16 (App Router, Server Actions, Server Components) · Supabase (Auth + Postgres + RLS) · Stripe (Checkout, Customer Portal, Webhooks) · Tailwind v4 + shadcn/ui (base-ui) · TypeScript strict.

## Features

- **Sign up / sign in** (`/signup`, `/login`) — email+password plus Google OAuth (PKCE). Email confirmation is mandatory before login, via a custom `/auth/confirm` route (not Supabase's built-in verify URL, for PKCE compatibility).
- **Onboarding** (`/onboarding`) — create an organization; the creator becomes owner automatically.
- **Pricing** (`/pricing`) — Basic/Pro plans → Stripe Checkout. Subscribe button hidden for non-owners, enforced server-side (`requireOrgOwner`).
- **Dashboard** (`/dashboard`) — current plan/status/renewal date, "Manage billing" → Stripe Customer Portal.
- **Notes** (`/notes`, gated on an active subscription) — organization-shared notes with RLS-enforced CRUD (edit/delete someone else's note is owner-only), server-side pagination/search/sort, and live updates via a **private** Supabase Realtime broadcast channel rather than `postgres_changes` (which doesn't apply RLS to `DELETE` events). Supports **file attachments** (images/PDF/docs, ≤10 MiB) uploaded directly from the browser to a private Storage bucket via a signed URL — see "Key technical decisions" for why.
- **Org switcher** — a user can belong to multiple organizations; the active one lives in a cookie, re-verified server-side on every switch.
- **Team members & email invites** (`/dashboard/members`) — owner invites by email+role via Resend; owner can remove members or change roles, both send a notification email.
- **Responsive header** — collapses into a mobile menu below 768px.
- **Routes are protected** both in `proxy.ts` and again on every server page — not just a UX convenience.

## Running locally

```bash
npm install
supabase start          # local Supabase in Docker
cp .env.example .env.local
# fill in .env.local from `supabase status` + Stripe test keys (see below)
npm run dev
```

Keep `stripe listen --forward-to localhost:3000/api/webhooks/stripe` running in a separate terminal for the whole session — without it, webhook events never reach `localhost` and `/dashboard` will look like the payment failed even though it succeeded. Missed an event anyway? `stripe events resend <event_id> --confirm`.

Use the same host everywhere — `127.0.0.1` or `localhost`, never mixed — browsers treat them as different cookie origins, which breaks the post-Checkout session. `.env.example`/`supabase/config.toml` are already aligned on `127.0.0.1`.

> If `npm run dev` loops on `Watchpack Error: EMFILE: too many open files`, that's a local file-descriptor limit, not a project bug — try `ulimit -n 10240` before `npm run dev`, or use `npm run build && npm run start` instead (no persistent watcher).

Walking the flow by hand:

1. `/signup` with email+password → check Mailpit at `http://127.0.0.1:54324` for the confirmation email → follow the link.
2. Onboarding: name a workspace → `/dashboard`.
3. `/pricing` → Subscribe → Checkout with `4242 4242 4242 4242`.
4. Back on `/dashboard`, subscription status updates via the webhook (needs `stripe listen` running, or `stripe trigger checkout.session.completed`).
5. `/notes` unlocks once the subscription is `active`/`trialing`.

Or skip Checkout and use the seeded accounts from `supabase/seed.sql` (password `password123` for all):

| Email | Organization | Role | Subscription |
|---|---|---|---|
| `owner_a@example.com` | Acme | owner | `active` — `/notes` unlocked |
| `member_a@example.com` | Acme | member | `active` — `/notes` unlocked, billing hidden |
| `owner_b@example.com` | Globex | owner | none — `/notes` shows the paywall |

Tests: `npm run test` (Vitest, needs local Supabase running — integration tests hit real tables).

Changed the DB schema? Regenerate types: `npm run db:types`.

### Checking something against production from the shell

`.env.local` always points at local Docker Supabase. For one-off checks against the hosted project, load a separate gitignored `.env.production.local` into just the current shell:

```bash
source scripts/env.sh production   # this shell only
source scripts/env.sh local        # back to local
```

## Google OAuth

Verified live end-to-end. Without real credentials, the button renders but fails at Google's consent screen (`invalid_client`) — expected on a fresh clone.

1. Create an OAuth 2.0 Client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Redirect URI (local): `http://127.0.0.1:54321/auth/v1/callback` (Supabase Auth's own callback).
3. Before `supabase start`, export `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` (see `supabase/config.toml`'s `[auth.external.google]`).
4. For production: same thing, real domain, set in Vercel/hosted Supabase.

## Stripe

### Environment variables

All in `.env.example`:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Server-side only (`lib/stripe.ts`). |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook signatures. From `stripe listen` locally, from the Dashboard in production. |
| `STRIPE_PRICE_ID_BASIC`, `STRIPE_PRICE_ID_PRO` | Plan Price ids. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Billing Portal config with plan-switching enabled (see below). |
| `NEXT_PUBLIC_APP_URL` | Base URL for Checkout/Portal redirects and invite emails. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public Supabase values. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only — webhook handler, invite acceptance, member roster lookups. |
| `RESEND_API_KEY` | Server-only — organization-invite emails. |

Test and live Stripe keys are never mixed: local/CI use test keys, production uses live keys.

### Test cards

- Success: `4242 4242 4242 4242`.
- Declined renewal (`invoice.payment_failed`): `4000 0000 0000 0341`.
- Full list: https://docs.stripe.com/testing

### Testing the webhook locally

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Prints a `whsec_...` for `STRIPE_WEBHOOK_SECRET`. Then, with `npm run dev` running too:

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
```

`tests/webhooks-stripe.test.ts` covers signature verification and idempotency automatically, without a real Stripe account (`generateTestHeaderString`).

### Switching plans in the Customer Portal

A default Stripe account's Customer Portal can't change plans — only cancel or update payment. Enable it with a portal configuration (`features.subscription_update.enabled = true`, `proration_behavior = "always_invoice"` for an immediate charge on upgrade):

```bash
curl https://api.stripe.com/v1/billing_portal/configurations \
  -u "$STRIPE_SECRET_KEY:" \
  -d "features[subscription_update][enabled]=true" \
  -d "features[subscription_update][proration_behavior]=always_invoice" \
  -d "features[subscription_update][default_allowed_updates][]=price" \
  -d "features[subscription_update][products][0][product]=<basic_product_id>" \
  -d "features[subscription_update][products][0][prices][0]=$STRIPE_PRICE_ID_BASIC" \
  -d "features[subscription_update][products][1][product]=<pro_product_id>" \
  -d "features[subscription_update][products][1][prices][0]=$STRIPE_PRICE_ID_PRO" \
  -d "features[subscription_cancel][enabled]=true" \
  -d "features[payment_method_update][enabled]=true"
```

Save the returned `id` as `STRIPE_PORTAL_CONFIGURATION_ID`.

## Manual steps before the first live Stripe run

1. Create a Stripe account, enable test mode.
2. Create Basic/Pro Products/Prices, set `STRIPE_PRICE_ID_BASIC`/`STRIPE_PRICE_ID_PRO`.
3. Set `STRIPE_SECRET_KEY`.
4. Run `stripe listen`, set `STRIPE_WEBHOOK_SECRET`.
5. Create a billing portal configuration (above), set `STRIPE_PORTAL_CONFIGURATION_ID`.
6. Run Checkout with the test card and confirm `subscriptions` updated.

## Key technical decisions

**RLS deny-by-default, not app-level `organization_id` filtering.** Every user-data table has RLS forced with separate select/insert/update/delete policies; one forgotten `.eq()` in application code can't leak data across organizations. Some logic that's normally application code (last-owner protection, cross-tenant integrity) lives in DB triggers instead — e.g. `trg_prevent_last_owner_change` uses an advisory lock to close a real race two concurrent removals could otherwise both win.

**Webhook idempotency is a claim/CAS state machine, not `insert ... on conflict do nothing`.** Naive "have we seen this event id" breaks under concurrent Stripe retries. `processed_stripe_events` holds an explicit `status` + `claim_token`: a duplicate either can't claim and gets `409` (forcing a real retry), or sees `status='succeeded'` and returns `200` — never based on row existence alone.

**Auth routes write cookies explicitly onto the response object**, not via ambient `cookies()` — a bug reproduced in practice where the ambient mutation didn't reliably reach the actual `NextResponse` returned, silently dropping sessions. `signOut()` uses `scope: "local"` for the same reason: the SDK's default (`"global"`) kills every session on every device, not just the current tab.

**Note attachments upload directly from the browser to Storage**, not through a Server Action carrying the bytes — Vercel serverless functions cap request bodies at ~4.5MB, well under the bucket's 10 MiB limit, so a real phone photo would be rejected before the app's own check ran. A Server Action mints a short-lived signed upload URL; the browser uploads straight to Storage; a second Server Action records the metadata once the bytes exist.

**Migrations apply to hosted Supabase as part of the Vercel build**, not a manual step — a schema change used to require running `supabase db push` by hand before pushing dependent code, easy to get backwards and briefly break the live site. `scripts/apply-production-migrations.mjs` runs at the start of every build, no-ops unless `VERCEL_ENV=production`, and fails the whole build (old deployment stays live) if the migration fails.
