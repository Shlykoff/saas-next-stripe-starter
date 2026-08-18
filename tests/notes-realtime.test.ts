import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import "@/lib/supabase/ensure-websocket-polyfill";
import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ---------------------------------------------------------------------------
// Integration test for the REAL security boundary behind /notes' live
// updates: the "notes_broadcast_authorized_org_members" RLS policy on
// realtime.messages (supabase/migrations/20260818174917_enable_notes_realtime.sql),
// exercised over an actual WebSocket connection with real signed-in JWTs
// from two different organizations -- not pgTAP faking
// request.jwt.claims. supabase/tests/notes_realtime_test.sql already proves
// the POLICY LOGIC is correct that way, but its own header explicitly
// disclaims that it "does NOT and CANNOT exercise... actually receiving an
// event client-side" or "the actual WebSocket protocol" -- this file closes
// exactly that gap, per the same file's "what nextjs-frontend must
// additionally verify" section.
//
// Deliberately does NOT reuse tests/setup.ts's mocked cookies()/signInAs
// (tests/auth-helpers.ts): that machinery exists to exercise Server
// Actions/Server Components through @supabase/ssr's cookie-bound client,
// which never opens a real Realtime socket. This file signs in with a
// plain @supabase/supabase-js client per user instead -- the same
// underlying client components/notes/notes-realtime.tsx uses
// (lib/supabase/client.ts's createBrowserSupabaseClient wraps
// @supabase/ssr's createBrowserClient, which itself wraps this same
// createClient) -- and calls `realtime.setAuth()` explicitly before
// subscribing, mirroring that component's own defensive call (see its doc
// comment for why).
// ---------------------------------------------------------------------------

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY. " +
      "Copy .env.example to .env.local (local Supabase must be running: `supabase start`).",
  );
}

// service_role client for setup/cleanup/triggering changes only -- bypasses
// RLS, never used to exercise the subscribe/authorization behavior under
// test (that's always done through a real signed-in anon-key client below).
const serviceClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_PASSWORD = "password123";
// Realtime broadcast delivery over a real WebSocket is genuinely
// asynchronous (network + Elixir Realtime server round trip), unlike the
// mocked-cookies Server Action tests elsewhere in this suite -- these
// windows are generous on purpose to avoid flaking on a loaded CI runner,
// not tuned to the bare minimum.
const EVENT_WAIT_MS = 4_000;
const NO_EVENT_WAIT_MS = 3_000;
const TEST_TIMEOUT_MS = 15_000;
// Short pause after `channel.subscribe()` resolves SUBSCRIBED, before
// triggering the writes it's supposed to observe -- SUBSCRIBED confirms the
// WebSocket join completed, not that the Realtime server has finished
// registering this session as an authorized receiver for the private topic
// yet. Doesn't replace waitForEvents()'s polling below (that's what
// actually makes the assertion robust); this just makes the common case
// hit the fast path instead of needing several poll iterations.
const JOIN_SETTLE_MS = 250;

interface TestUser {
  id: string;
  email: string;
}

async function createTestUser(label: string): Promise<TestUser> {
  const email = `notes-rt-${label}-${randomUUID()}@example.com`;
  const { data, error } = await serviceClient.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw error ?? new Error(`Failed to create test user ${email}`);
  }
  return { id: data.user.id, email };
}

async function createTestOrg(name: string, ownerId: string): Promise<string> {
  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .insert({ name, slug: `notes-rt-${randomUUID()}` })
    .select("id")
    .single();
  if (orgError || !org) {
    throw orgError ?? new Error("Failed to create test organization");
  }

  const { error: memberError } = await serviceClient
    .from("organization_members")
    .insert({ organization_id: org.id, user_id: ownerId, role: "owner" });
  if (memberError) throw memberError;

  return org.id;
}

/**
 * Signs in a real (non-mocked) supabase-js client as `user` and explicitly
 * attaches the resulting session's access token to its Realtime client --
 * `supabase.realtime.setAuth(token)`, the same call
 * components/notes/notes-realtime.tsx makes before subscribing, so the
 * private channel below is authorized as this user's own JWT rather than
 * racing supabase-js's internal async onAuthStateChange sync.
 */
async function createSignedInClient(user: TestUser): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(supabaseUrl!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email: user.email,
    password: TEST_PASSWORD,
  });
  if (signInError) throw signInError;

  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) throw new Error(`Signed in as ${user.email}, but no session was returned.`);

  client.realtime.setAuth(session.access_token);
  return client;
}

interface BroadcastEvent {
  event: string;
  payload: {
    operation: string;
    record: Record<string, unknown> | null;
    old_record: Record<string, unknown> | null;
  };
}

/**
 * Subscribes to the private `notes:org:<organizationId>` channel exactly as
 * components/notes/notes-realtime.tsx does (three explicit INSERT/UPDATE/
 * DELETE handlers, `config: { private: true }`), collecting every event
 * received into `events`. Resolves once the join settles either way --
 * `SUBSCRIBED` (authorized) or a terminal failure status (refused) -- so
 * callers can assert on the join outcome itself, not just on what arrives
 * afterward.
 */
function subscribeToNotesTopic(
  client: SupabaseClient<Database>,
  organizationId: string,
  events: BroadcastEvent[],
): Promise<{ channel: RealtimeChannel; status: string; error?: Error }> {
  const channel = client.channel(`notes:org:${organizationId}`, {
    config: { private: true },
  });

  channel
    .on("broadcast", { event: "INSERT" }, (payload) => events.push(payload as unknown as BroadcastEvent))
    .on("broadcast", { event: "UPDATE" }, (payload) => events.push(payload as unknown as BroadcastEvent))
    .on("broadcast", { event: "DELETE" }, (payload) => events.push(payload as unknown as BroadcastEvent));

  return new Promise((resolve) => {
    channel.subscribe((status, error) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        resolve({ channel, status, error });
      }
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until `events.length >= count` or `timeoutMs` elapses, instead of a
 * single fixed `wait()` before asserting on `events`.
 *
 * A fixed sleep here was reproduced flaking (~1-in-6 runs, matching qa's
 * own repro of ~1-in-5): `channel.subscribe()`'s `SUBSCRIBED` callback
 * confirms the WebSocket join itself completed, but not that the Realtime
 * server has finished registering this specific session as an authorized
 * receiver for the private topic by the moment right after -- there's a
 * short window where the server-role client's very first INSERT can be
 * broadcast before that registration has actually landed, and a fixed
 * `wait(4000)` either caught it (usually) or didn't (rarely), with no way
 * to tell which without just... polling. This is the same class of fix
 * already applied elsewhere in this suite for a concurrent-accept race
 * (tests/invites.test.ts) -- don't assume a fixed delay is enough for an
 * async system to settle; wait for the actual condition, bounded by an
 * overall timeout so a genuine failure (the event never arrives at all)
 * still fails instead of hanging.
 */
async function waitForEvents(events: BroadcastEvent[], count: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const pollIntervalMs = 50;
  while (events.length < count) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${count} broadcast event(s); received ${events.length}: ` +
          JSON.stringify(events.map((e) => e.event)),
      );
    }
    await wait(pollIntervalMs);
  }
}

const cleanupOrgIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupNoteIds: string[] = [];
const cleanupClients: SupabaseClient<Database>[] = [];
const cleanupChannels: { client: SupabaseClient<Database>; channel: RealtimeChannel }[] = [];

afterAll(async () => {
  for (const { client, channel } of cleanupChannels) {
    await client.removeChannel(channel).catch(() => {});
  }
  for (const client of cleanupClients) {
    await client.auth.signOut().catch(() => {});
  }
  // FK order: notes.author_id -> auth.users has no ON DELETE action
  // (RESTRICT, see supabase/migrations/20260817212642_add_notes.sql), so
  // notes must be deleted before their authors; organizations before users
  // for the same reason on organization_members.
  if (cleanupNoteIds.length > 0) {
    await serviceClient.from("notes").delete().in("id", cleanupNoteIds);
  }
  for (const orgId of cleanupOrgIds) {
    await serviceClient.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of cleanupUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
}, 30_000);

describe("notes:org:<id> private Realtime broadcast channel -- real WebSocket, real JWTs", () => {
  it(
    "a member of org A, subscribed to notes:org:<A>, receives INSERT/UPDATE/DELETE broadcasts for org A's notes",
    async () => {
      const memberA = await createTestUser("member-a");
      cleanupUserIds.push(memberA.id);
      const orgAId = await createTestOrg("RT Live Org A", memberA.id);
      cleanupOrgIds.push(orgAId);

      const clientA = await createSignedInClient(memberA);
      cleanupClients.push(clientA);

      const events: BroadcastEvent[] = [];
      const { channel, status, error } = await subscribeToNotesTopic(clientA, orgAId, events);
      cleanupChannels.push({ client: clientA, channel });

      expect(error).toBeUndefined();
      expect(status).toBe("SUBSCRIBED");
      await wait(JOIN_SETTLE_MS);

      const { data: note, error: insertError } = await serviceClient
        .from("notes")
        .insert({ organization_id: orgAId, author_id: memberA.id, title: "Live note", body: "v1" })
        .select("id")
        .single();
      if (insertError || !note) throw insertError ?? new Error("setup insert failed");
      cleanupNoteIds.push(note.id);

      await serviceClient.from("notes").update({ body: "v2" }).eq("id", note.id);
      await serviceClient.from("notes").delete().eq("id", note.id);
      cleanupNoteIds.splice(cleanupNoteIds.indexOf(note.id), 1); // already gone -- nothing left to clean up

      await waitForEvents(events, 3, EVENT_WAIT_MS);

      expect(events.map((e) => e.event)).toEqual(["INSERT", "UPDATE", "DELETE"]);
      expect(events[0].payload.record?.id).toBe(note.id);
      expect(events[0].payload.record?.title).toBe("Live note");
      expect(events[1].payload.old_record?.body).toBe("v1");
      expect(events[1].payload.record?.body).toBe("v2");
      // DELETE: the whole reason this feature isn't built on postgres_changes
      // (see notes-realtime.tsx's doc comment) -- proving it over the real
      // socket, not just via pgTAP.
      expect(events[2].payload.old_record?.id).toBe(note.id);
      expect(events[2].payload.record).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a member of org B, subscribing directly to notes:org:<A> (a topic their own UI would never construct), " +
      "is refused with no data leak and receives zero events for org A's changes",
    async () => {
      const memberA = await createTestUser("member-a2");
      cleanupUserIds.push(memberA.id);
      const orgAId = await createTestOrg("RT Isolation Org A", memberA.id);
      cleanupOrgIds.push(orgAId);

      const memberB = await createTestUser("member-b2");
      cleanupUserIds.push(memberB.id);
      const orgBId = await createTestOrg("RT Isolation Org B", memberB.id);
      cleanupOrgIds.push(orgBId);
      void orgBId; // exists only so memberB is a genuine member of SOME org, not an orphaned account

      const clientB = await createSignedInClient(memberB);
      cleanupClients.push(clientB);

      const events: BroadcastEvent[] = [];
      const { channel, status, error } = await subscribeToNotesTopic(clientB, orgAId, events);
      cleanupChannels.push({ client: clientB, channel });

      // The join itself is refused server-side -- the live equivalent of
      // pgTAP Part E's is_empty() assertion in
      // supabase/tests/notes_realtime_test.sql, now proven over the actual
      // WebSocket/JWT path that file's own header says pgTAP cannot reach.
      expect(status).toBe("CHANNEL_ERROR");
      // No data leak in the refusal itself: it says "unauthorized", not
      // anything that reveals org A exists, its name, or its notes.
      expect(String(error)).toMatch(/unauthorized/i);
      expect(String(error)).not.toMatch(/RT Isolation Org A/);

      const { data: note, error: insertError } = await serviceClient
        .from("notes")
        .insert({ organization_id: orgAId, author_id: memberA.id, title: "Should never reach org B", body: "" })
        .select("id")
        .single();
      if (insertError || !note) throw insertError ?? new Error("setup insert failed");
      cleanupNoteIds.push(note.id);

      await wait(NO_EVENT_WAIT_MS);

      expect(events).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
