// Pure, framework-free helpers for /notes' ?page=/?sort= query params --
// deliberately split out of lib/notes.ts (which starts with "server-only"
// and does the actual Supabase query) so client components
// (components/notes/notes-toolbar.tsx) can import the NoteSort type and the
// NOTE_SORT_OPTIONS list that drives its <Select> WITHOUT dragging the
// "server-only" guard into the client bundle -- Next.js's bundler treats
// that as a hard build error (any import from a module, even for a
// same-file constant, pulls in that module's own top-level imports), same
// rationale as lib/note-validation.ts and lib/subscription-access.ts being
// their own import-free files instead of living inside lib/notes.ts /
// lib/subscriptions.ts.

/** Notes shown per page on /notes (app/notes/page.tsx's server-side pagination, lib/notes.ts's query). */
export const NOTES_PAGE_SIZE = 20;

export type NoteSort = "newest" | "oldest" | "title_asc";
export const DEFAULT_NOTE_SORT: NoteSort = "newest";

/** Drives both the sort <Select> (components/notes/notes-toolbar.tsx) and parseNoteSort below. */
export const NOTE_SORT_OPTIONS: ReadonlyArray<{ value: NoteSort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title_asc", label: "Title A-Z" },
];

/** Parses `?sort=` into a known NoteSort, falling back to the default for anything else (including absent/tampered values). */
export function parseNoteSort(raw: string | undefined): NoteSort {
  return raw === "oldest" || raw === "title_asc" ? raw : DEFAULT_NOTE_SORT;
}

/** Parses `?page=` into a 1-indexed page number, clamped to >= 1 for anything absent/non-numeric/negative. */
export function parseNotePage(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
