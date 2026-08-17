import "server-only";
import Stripe from "stripe";

// server-only guards against this module (and the secret key it wraps) ever
// being pulled into a client component bundle by accident -- if that ever
// happens, the build fails instead of shipping STRIPE_SECRET_KEY to the
// browser. See CLAUDE.md non-negotiable #2 (same posture as the Supabase
// service_role key).

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error(
    "STRIPE_SECRET_KEY is not set. Copy .env.example to .env.local and fill " +
      "in your Stripe *test mode* secret key (sk_test_...) from " +
      "https://dashboard.stripe.com/test/apikeys.",
  );
}

// Pinned to the API version shipped with the installed `stripe` package
// (see node_modules/stripe/cjs/apiVersion.d.ts). Pinning explicitly --
// rather than leaving it implicit -- means a future `npm install stripe@latest`
// can't silently change the shape of webhook payloads this app parses;
// bumping the pin is a deliberate, reviewable change.
export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2026-07-29.dahlia",
  typescript: true,
  appInfo: {
    name: "saas-starter",
  },
});
