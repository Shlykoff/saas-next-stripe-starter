import "server-only";
import { Resend } from "resend";

// server-only guards against this module (and the API key it wraps) ever
// being pulled into a client component bundle by accident -- same posture as
// lib/stripe.ts and lib/supabase/service-role.ts (CLAUDE.md non-negotiable #2).
//
// Why the `resend` package instead of a raw fetch to Resend's REST API: this
// app already has exactly one precedent for "official SDK wrapping a
// third-party REST API" (lib/stripe.ts, the `stripe` package) rather than
// hand-rolled fetch calls -- typed request/response shapes, and errors that
// come back as real Error instances (a raw fetch would need its own
// non-2xx-response-is-still-a-resolved-promise handling, which the SDK
// already does). Organization-invite email is the only send site today
// (app/actions/invites.ts), so the SDK's small footprint doesn't buy much
// yet, but it's the same tradeoff already made once for Stripe and keeps the
// codebase consistent rather than having two different conventions for
// "call a REST API server-side."
const resendApiKey = process.env.RESEND_API_KEY;

if (!resendApiKey) {
  throw new Error(
    "RESEND_API_KEY is not set. Copy .env.example to .env.local and fill in a Resend API key from " +
      "https://resend.com/api-keys -- this is the SAME key already used as the password in Supabase's " +
      "Custom SMTP settings for auth emails; it's also needed here directly because organization-invite " +
      "email is our own transactional email, not a Supabase Auth event.",
  );
}

export const resend = new Resend(resendApiKey);

// Domain already verified in Resend for the Custom SMTP sender used by
// Supabase Auth emails (confirmation, password reset) -- see .env.example.
// Reusing the same verified domain/address for this app's own transactional
// email (organization invites) avoids provisioning a second sender identity.
export const INVITE_EMAIL_FROM = "SaaS Starter <noreply@mail.shlykoff.com>";
