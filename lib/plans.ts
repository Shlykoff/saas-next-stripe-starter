// Minimal plan config for the MVP: 2-3 plans per docs/spec.md, each backed
// by a Stripe Price id supplied via env var (see .env.example) rather than
// hardcoded, so switching from Stripe test-mode to live-mode prices is a
// config change, not a code change. nextjs-frontend renders these on the
// pricing page; the actual Product/Price objects have to be created once in
// the Stripe Dashboard (test mode) by whoever has Stripe API access -- this
// repo only references their ids.
export interface Plan {
  id: string;
  name: string;
  description: string;
  /** Stripe Price id, read from env at request time (not baked in at build time). */
  priceEnvVar: "STRIPE_PRICE_ID_BASIC" | "STRIPE_PRICE_ID_PRO";
}

export const PLANS: readonly Plan[] = [
  {
    id: "basic",
    name: "Basic",
    description: "For individuals getting started.",
    priceEnvVar: "STRIPE_PRICE_ID_BASIC",
  },
  {
    id: "pro",
    name: "Pro",
    description: "For growing teams.",
    priceEnvVar: "STRIPE_PRICE_ID_PRO",
  },
];

/** Resolves a plan's Stripe Price id from env, or null if not configured yet. */
export function resolvePlanPriceId(plan: Plan): string | null {
  return process.env[plan.priceEnvVar] || null;
}

/** The set of all price ids this app is willing to start a Checkout Session for. */
export function allowedPriceIds(): string[] {
  return PLANS.map(resolvePlanPriceId).filter((id): id is string => Boolean(id));
}
