import { config } from "dotenv";
import path from "node:path";
import { vi } from "vitest";

// Same env vars `npm run dev` uses (local Supabase URL/keys, Stripe
// placeholders) -- see .env.local / .env.example. Loaded explicitly here
// because vitest doesn't read Next.js's env-loading convention on its own.
config({ path: path.resolve(__dirname, "../.env.local") });

// The real "server-only" package unconditionally throws when imported
// outside Next.js's "react-server" bundler condition (see
// node_modules/server-only/index.js) -- which is exactly the condition
// Node/vitest runs under. Next.js itself resolves "server-only" to a no-op
// via that condition at build time; this mock reproduces the same no-op for
// tests so lib/stripe.ts and lib/supabase/*.ts (which import it as a
// leak-into-client-bundle guard) can be imported directly.
vi.mock("server-only", () => ({}));
