import "server-only";

// Shared helper for the base URL this app uses when it needs to build an
// absolute link server-side: Stripe Checkout/Portal success/cancel/return
// URLs (app/actions/billing.ts) and organization-invite email links
// (app/actions/invites.ts). Pulled out of billing.ts (which used to keep a
// private copy) so both call sites can't drift out of sync -- see
// NEXT_PUBLIC_APP_URL's own comment in .env.example for why the exact host
// (127.0.0.1 vs localhost) matters for cookies. Falls back to localhost so
// `npm run dev` works without extra setup.
export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}
