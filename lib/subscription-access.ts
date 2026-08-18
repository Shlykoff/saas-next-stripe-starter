// Pure, framework-free gating rule: which Stripe subscription statuses grant
// access to paid product features (the /notes gated feature, and anywhere
// else that needs the same rule later). Deliberately has NO imports (no
// "server-only", no Supabase client) so it can be unit-tested in complete
// isolation and reused from both server components/actions AND, if ever
// needed, from a client component for purely cosmetic UI (e.g. dimming a
// nav link) -- the actual access decision must still always be re-checked
// server-side wherever it gates real data or actions (see app/notes/page.tsx),
// never trusted from a client-side copy of this same function.
//
// Named literals mirror the `status` check constraint on
// public.subscriptions (see
// supabase/migrations/20260817171827_init_core_schema.sql, section 3).
// Kept as documentation/autocomplete, not the actual parameter type below:
// database.types.ts (generated from the live schema) types the column as
// plain `string | null` rather than this literal union, so functions here
// accept `string | null | undefined` -- the `(string & {})` half of
// SubscriptionStatus is what lets a plain DB-sourced string be passed
// without TS rejecting it, while still offering the known literals for
// autocomplete at call sites that type a literal directly (e.g. tests).
export type KnownSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export type SubscriptionStatus = KnownSubscriptionStatus | (string & {}) | null | undefined;

// Only these two Stripe statuses represent "customer should have access to
// paid features right now": 'active' (currently paying) and 'trialing'
// (inside a Stripe-configured trial period, not yet charged). Every other
// status -- including 'past_due', which still technically has billing
// retries in flight -- is treated as NO access; a lapsed/failing payment
// should re-show the paywall rather than silently keep access, per
// docs/spec.md's "graceful обработка отменённой/просроченной подписки в UI
// (баннер «переоформите подписку»)".
const STATUSES_WITH_ACCESS: ReadonlySet<string> = new Set(["active", "trialing"]);

/** True if `status` grants access to subscription-gated product features. */
export function hasActiveSubscriptionAccess(status: SubscriptionStatus): boolean {
  return typeof status === "string" && STATUSES_WITH_ACCESS.has(status);
}

/** Human-readable label for a subscription status, for badges/banners. */
export function subscriptionStatusLabel(status: SubscriptionStatus): string {
  if (!status) return "No subscription";
  const labels: Record<string, string> = {
    active: "Active",
    trialing: "Trialing",
    past_due: "Past due",
    canceled: "Canceled",
    unpaid: "Unpaid",
    incomplete: "Incomplete",
    incomplete_expired: "Expired",
    paused: "Paused",
  };
  return labels[status] ?? status;
}

/** shadcn Badge `variant` to pair with a given subscription status. */
export function subscriptionStatusBadgeVariant(
  status: SubscriptionStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (hasActiveSubscriptionAccess(status)) return "default";
  if (status === "past_due" || status === "unpaid") return "destructive";
  if (!status) return "outline";
  return "secondary";
}
