import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "./supabase/database.types";
import { NOTES_PAGE_SIZE, DEFAULT_NOTE_SORT, type NoteSort } from "./note-query-params";

export type NoteRow = Tables<"notes">;

// Sort/pagination constants and ?page=/?sort= parsers live in
// lib/note-query-params.ts (no "server-only", no imports) so client
// components can use them without pulling this file's Supabase/server-only
// imports into the browser bundle -- re-exported here so existing server
// call sites (app/notes/page.tsx) can still import everything from
// "@/lib/notes" in one place.
export { NOTES_PAGE_SIZE, DEFAULT_NOTE_SORT, NOTE_SORT_OPTIONS, parseNoteSort, parseNotePage } from "./note-query-params";
export type { NoteSort } from "./note-query-params";

export interface GetOrganizationNotesOptions {
  /** 1-indexed page number. Values < 1 are clamped to 1. */
  page?: number;
  pageSize?: number;
  /** Free-text search over title/body (case-insensitive substring, ILIKE). */
  search?: string;
  sort?: NoteSort;
}

export interface PaginatedNotes {
  notes: NoteRow[];
  page: number;
  pageSize: number;
  /** Total rows matching the (RLS + search) filter, across every page -- not just this page's length. */
  totalCount: number;
  totalPages: number;
}

/**
 * Escapes a raw search term for safe interpolation into a PostgREST `.or()`
 * filter string. Two different escaping concerns, both real correctness
 * bugs (not just precision nits) if skipped:
 *
 *   1. `.or()` takes one comma-separated string of conditions
 *      (`title.ilike.%x%,body.ilike.%x%`) -- a literal comma (or `.`, `(`,
 *      `)`) typed into the search box would otherwise be parsed as PostgREST
 *      filter syntax instead of literal search text, corrupting or erroring
 *      the query. Wrapping the value in double quotes is PostgREST's own
 *      documented escape hatch for exactly this.
 *   2. A literal `"` or `\` inside a double-quoted PostgREST value has to be
 *      backslash-escaped itself, or it would prematurely close the quoted
 *      value.
 *
 * Deliberately NOT escaping `%`/`_` (the actual ILIKE wildcard characters)
 * -- letting a user's own `%`/`_` act as a wildcard is a harmless MVP
 * simplification (per this feature's spec: plain `ilike '%term%'` is
 * "enough for MVP"), not a security issue, since this only ever runs
 * against RLS-scoped rows the caller could already read.
 */
function toIlikePattern(term: string): string {
  const escaped = term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"%${escaped}%"`;
}

/** True for PostgREST's PGRST103 ("Requested range not satisfiable") -- the error `.range()` throws for ANY offset at or past the real row count, not just implausibly large values. */
function isRangeNotSatisfiableError(error: { code?: string } | null): boolean {
  return error?.code === "PGRST103";
}

/**
 * Reads a page of an organization's notes, with optional search and sort.
 * Goes through the session-bound (anon-key) client, so this is subject to
 * "notes_select_members" RLS -- returns an empty page both when the org
 * genuinely has no (matching) notes AND when the caller isn't a member of
 * organizationId (RLS returns zero rows, not an error), same pattern as
 * lib/subscriptions.ts's getOrganizationSubscription.
 *
 * Two-query shape, deliberately -- NOT "one `.range()` query with
 * `count:'exact'` attached", which is what this used to be:
 *
 *   1. A lightweight `head: true` count-only request (same eq/search
 *      filters, no `.range()`, no rows returned) to learn the REAL total
 *      first.
 *   2. The actual data page, `.range()`d against a `page` clamped to that
 *      real total (`Math.min(requestedPage, totalPages)`).
 *
 * Reproduced directly against local Postgres/PostgREST before writing this:
 * `.range()` throws PGRST103 ("Requested range not satisfiable") for ANY
 * offset at or past the real row count -- not only an implausible
 * hand-typed `?page=99999999999999`, but also perfectly ordinary
 * navigation (another org member deletes enough notes between page loads
 * that the page a viewer is already sitting on no longer exists). Left
 * unguarded, that error propagated straight out of this function,
 * uncaught, and crashed the whole /notes route with a 500 instead of
 * simply showing the last real page. Clamping `page` against a
 * known-fresh count before the range query is ever issued is what actually
 * prevents that, rather than only special-casing implausibly large input.
 *
 * The extra round trip is worth it for a feature whose whole point is a
 * paginator that must never crash on a stale/tampered ?page= -- `head:
 * true` keeps it cheap (no row data over the wire, just the count).
 */
export async function getOrganizationNotes(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  options: GetOrganizationNotesOptions = {},
): Promise<PaginatedNotes> {
  const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : NOTES_PAGE_SIZE;
  const requestedPage = options.page && options.page >= 1 ? Math.floor(options.page) : 1;
  const search = options.search?.trim() ?? "";
  const sort = options.sort ?? DEFAULT_NOTE_SORT;
  const searchPattern = search ? toIlikePattern(search) : null;

  // Step 1: real total first, via a `head: true` count-only request.
  let countQuery = supabase.from("notes").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  if (searchPattern) {
    countQuery = countQuery.or(`title.ilike.${searchPattern},body.ilike.${searchPattern}`);
  }
  const { count, error: countError } = await countQuery;
  if (countError) {
    throw new Error(`Failed to load notes: ${countError.message}`);
  }

  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  // Clamp to the last real page rather than letting a stale/tampered
  // ?page= reach PostgREST's .range() as an invalid offset -- see doc
  // comment above.
  const page = Math.min(requestedPage, totalPages);

  // Step 2: the actual page of data, now a guaranteed in-range offset for
  // the count just measured -- except for the rare TOCTOU window between
  // the two requests (concurrent deletes could shrink the real total again
  // in between), handled defensively below rather than assumed away.
  let dataQuery = supabase.from("notes").select("*").eq("organization_id", organizationId);
  if (searchPattern) {
    dataQuery = dataQuery.or(`title.ilike.${searchPattern},body.ilike.${searchPattern}`);
  }

  const orderedQuery =
    sort === "oldest"
      ? dataQuery.order("created_at", { ascending: true })
      : sort === "title_asc"
        ? dataQuery.order("title", { ascending: true })
        : dataQuery.order("created_at", { ascending: false });

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error } = await orderedQuery.range(from, to);

  if (error) {
    if (isRangeNotSatisfiableError(error)) {
      // The rare TOCTOU case from the comment above actually happened --
      // treat it exactly like "no notes on this page" (the honest answer
      // regardless of why the offset stopped being valid) rather than
      // propagating PostgREST's error to the caller.
      return { notes: [], page, pageSize, totalCount, totalPages };
    }
    throw new Error(`Failed to load notes: ${error.message}`);
  }

  return {
    notes: data ?? [],
    page,
    pageSize,
    totalCount,
    totalPages,
  };
}
