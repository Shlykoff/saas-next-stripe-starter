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

// revalidatePath() throws ("Invariant: static generation store missing")
// when called outside an actual Next.js request/render context, which is
// exactly the situation calling a "use server" action (e.g.
// app/actions/notes.ts) directly from a Vitest test is. Next.js itself
// wires this up to a real cache-invalidation side effect at request time;
// here it's a no-op so server actions can be exercised end-to-end
// (including their real success path) without spinning up a full Next.js
// server just to satisfy this one call.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// Shared in-memory cookie jar, mocking next/headers's cookies() for every
// test file. This is what BOTH of the following need, and need to agree
// with each other on, within one test file's run:
//   1. "Sign in as X" in an integration test (e.g. tests/notes.test.ts,
//      tests/invites.test.ts), which calls supabase.auth.signInWithPassword()
//      through a REAL @supabase/ssr server client (lib/supabase/server.ts) --
//      that client's setAll() writes the resulting session cookies here.
//   2. Any application code under test that separately reads/writes a
//      cookie via next/headers directly -- e.g. lib/org.ts's
//      ACTIVE_ORG_COOKIE (getActiveOrganization / requireOrgOwner) --
//      needs to see the SAME jar, exactly like a real browser has exactly
//      one cookie jar shared across every request in production, not two
//      unrelated mocks that happen to coincidentally agree.
// Exported so individual test files can `cookieJar.clear()` between cases
// (see tests/notes.test.ts) instead of maintaining a second, private jar.
export const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...cookieJar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));
