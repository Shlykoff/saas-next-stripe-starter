"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/** Minimum time between two router.refresh() calls triggered by this component. */
const MIN_REFRESH_INTERVAL_MS = 3_000;

/**
 * Re-fetches the current route's Server Component data when the tab regains
 * focus/visibility, so a page that was left open and went stale (e.g.
 * /dashboard/members still showing an invite as "pending" after it was
 * accepted from a different tab/browser/session) catches up as soon as the
 * owner comes back to it -- no manual reload needed.
 *
 * This is the deliberately lightweight "revalidate on focus" pattern rather
 * than Supabase Realtime/websockets: consistent with README's documented
 * choice not to build real-time updates between organization members for
 * /notes either (same tradeoff -- see "Known limitations").
 *
 * Renders nothing. Mount it once on whichever page(s) actually need this;
 * it is not global app behavior.
 */
export function RefreshOnFocus() {
  const router = useRouter();
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    function refreshIfDue() {
      if (document.visibilityState !== "visible") return;

      const now = Date.now();
      if (now - lastRefreshRef.current < MIN_REFRESH_INTERVAL_MS) return;

      lastRefreshRef.current = now;
      router.refresh();
    }

    document.addEventListener("visibilitychange", refreshIfDue);
    window.addEventListener("focus", refreshIfDue);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfDue);
      window.removeEventListener("focus", refreshIfDue);
    };
  }, [router]);

  return null;
}
