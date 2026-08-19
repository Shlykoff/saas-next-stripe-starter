#!/usr/bin/env node

// Runs at the START of `npm run build`, on EVERY build (local, CI, every
// Vercel deployment) -- but is a genuine no-op unless this specific build
// is a Vercel Production build. Vercel sets VERCEL_ENV=production/preview/
// development automatically; it is never set locally or in GitHub Actions
// CI, so neither of those is affected by this script at all.
//
// Why this exists: migrations used to be applied by hand (`supabase db
// push`, run manually from a developer's shell) as a separate step before
// pushing application code that depended on the new schema -- easy to
// forget, or to get the ORDER wrong (push code first, migration second),
// which briefly breaks the live site for every user until the migration
// catches up (a real query -- lib/notes.ts's `note_attachments(*)` embed --
// would 500 against a table that doesn't exist yet on hosted Supabase).
// Folding the migration into the build step itself removes the ordering
// hazard structurally: Vercel does not serve a new deployment until its
// build succeeds, so "migration applied" and "new code goes live" become
// one atomic unit from the outside -- either both happen, or neither does.
//
// Gated strictly to VERCEL_ENV === "production", not merely "is
// POSTGRES_URL_NON_POOLING set": that variable is present in Preview and
// Development Vercel environments too (auto-injected by the Supabase
// Vercel integration), and this project has no separate staging database
// (see README's "two environments" section) -- Preview deployments (e.g.
// building a PR branch) point at the SAME hosted Supabase project
// Production does. Without this exact gate, a Preview build would apply
// migrations to production on every PR, which is not what "preview" is
// supposed to mean.
//
// `supabase db push` is idempotent: it tracks already-applied migrations in
// supabase_migrations.schema_migrations on the remote database and only
// applies ones it hasn't seen, so running this unconditionally on every
// production build (even when nothing changed) is cheap and safe, not just
// "safe the first time."
//
// Exits non-zero on failure -- which fails the whole `npm run build`, which
// fails the whole Vercel deployment. Deliberately fail-closed: if a
// migration is broken, the OLD deployment (matching the OLD schema) stays
// live, rather than shipping new application code on top of a schema it
// doesn't actually match.

import { execFileSync } from "node:child_process";

if (process.env.VERCEL_ENV !== "production") {
  console.log(
    `[migrate] VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"} -- not a Vercel Production build, skipping migrations.`,
  );
  process.exit(0);
}

const dbUrl = process.env.POSTGRES_URL_NON_POOLING;
if (!dbUrl) {
  console.error(
    "[migrate] VERCEL_ENV=production but POSTGRES_URL_NON_POOLING is not set in this Vercel project's " +
      "Production environment variables -- refusing to build without applying migrations.",
  );
  process.exit(1);
}

console.log("[migrate] VERCEL_ENV=production -- applying pending Supabase migrations before build...");
execFileSync("npx", ["supabase", "db", "push", "--db-url", dbUrl, "--yes"], {
  stdio: "inherit",
});
console.log("[migrate] Migrations applied (or already up to date).");
