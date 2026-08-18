"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

/** Idle time after the last broadcast event before router.refresh() actually runs, so a burst of changes collapses into one re-fetch. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Live-updates /notes when another session (a teammate, or this same user
 * in a different tab) creates, edits, or deletes a note in this
 * organization -- without a manual page reload.
 *
 * Subscribes to the PRIVATE broadcast channel `notes:org:<organizationId>`
 * populated by the `trg_notes_broadcast_changes` trigger and authorized by
 * the `notes_broadcast_authorized_org_members` RLS policy on
 * `realtime.messages` (supabase/migrations/20260818174917_enable_notes_realtime.sql).
 * Deliberately NOT `postgres_changes` with a client-side
 * `filter: organization_id=eq.<id>` -- that mechanism does not evaluate RLS
 * for DELETE events at all (a documented Postgres/Supabase limitation:
 * there is no row left to check a SELECT policy against once it's gone), so
 * a naive postgres_changes subscription would broadcast every
 * organization's note deletions to every subscriber regardless of
 * `filter:`, which is UX scoping only, not a security boundary, for that
 * one event type. The private channel here is authorized SERVER-SIDE,
 * per-subscriber, for INSERT/UPDATE/DELETE alike -- verified against a real
 * WebSocket connection and two real organizations in
 * tests/notes-realtime.test.ts, not just trusted from the migration's own
 * comment.
 *
 * On any INSERT/UPDATE/DELETE, calls router.refresh() (debounced) rather
 * than patching local React state from the broadcast payload directly.
 * Chosen deliberately: app/notes/page.tsx's list is already
 * paginated/searched/sorted (?page=/?q=/?sort=) via a Server Component
 * query in lib/notes.ts -- re-running that exact query is what correctly
 * answers "does the changed note belong on the page/filter the viewer is
 * currently looking at", which the broadcast payload alone can't (it knows
 * the note that changed, not whether it matches the viewer's current search
 * term or sits in-range for their current page). Re-implementing that
 * filtering logic client-side to patch state locally would be a second copy
 * of lib/notes.ts's query semantics that can drift out of sync -- the same
 * "revalidate, don't hand-patch" call already made for
 * components/refresh-on-focus.tsx, just event-driven here instead of
 * focus-driven, and debounced far more tightly (300ms vs. that component's
 * 3s throttle) since this IS the live-feedback path rather than a fallback
 * for a stale background tab.
 *
 * Renders nothing. Multiple tabs/sessions each mount their own instance and
 * open their own channel -- there's no cross-tab dedup, which is fine:
 * Realtime supports many concurrent subscribers per topic, and each tab
 * cleans up its own channel (`supabase.removeChannel`) on unmount so
 * navigating away from /notes doesn't leak a live socket subscription.
 */
export function NotesRealtime({ organizationId }: { organizationId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    }

    async function subscribe() {
      // Defensive, not merely belt-and-suspenders: @supabase/supabase-js
      // DOES sync the Realtime client's auth token automatically off an
      // internal `auth.onAuthStateChange` listener (see
      // node_modules/@supabase/supabase-js's SupabaseClient
      // `_listenForAuthEvents`/`_handleTokenChanged`), but that listener
      // fires asynchronously off an INITIAL_SESSION event whose timing
      // relative to this effect isn't guaranteed. Explicitly awaiting
      // getSession() (which itself waits for the client's initial session
      // load to finish) and calling `realtime.setAuth()` before the very
      // first `.channel().subscribe()` removes that race: subscribing
      // before the token is attached would make this connection look
      // unauthenticated to `notes_broadcast_authorized_org_members`
      // (`to authenticated` only) and it would receive nothing -- safe by
      // default, but a silent functional bug rather than a security one.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled || !session) return;
      supabase.realtime.setAuth(session.access_token);
      if (cancelled) return;

      channel = supabase.channel(`notes:org:${organizationId}`, {
        config: { private: true },
      });

      channel
        .on("broadcast", { event: "INSERT" }, scheduleRefresh)
        .on("broadcast", { event: "UPDATE" }, scheduleRefresh)
        .on("broadcast", { event: "DELETE" }, scheduleRefresh)
        .subscribe();
    }

    subscribe();

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (channel) supabase.removeChannel(channel);
    };
  }, [organizationId, router]);

  return null;
}
