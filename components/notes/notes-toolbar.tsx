"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NOTE_SORT_OPTIONS, DEFAULT_NOTE_SORT, type NoteSort } from "@/lib/note-query-params";

/** Idle time after the last keystroke before the search term is pushed into the URL (and the server re-queries). */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Search box + sort <Select> for /notes. Both are controlled entirely by
 * the URL (?q=, ?sort=) rather than component state that the Server
 * Component (app/notes/page.tsx) would need a separate channel to learn
 * about -- changing either here just navigates to a new URL, which Next.js
 * re-renders app/notes/page.tsx for with the new searchParams, same "URL is
 * the source of truth" shape as everywhere else pagination/filtering
 * appears in this app.
 *
 * Search is debounced client-side before it touches the URL/server (typing
 * "hello" must not fire 5 server round-trips); sort applies immediately on
 * selection, since a <Select> change is already a single discrete
 * "decision" and doesn't need the same protection.
 *
 * Any change here also drops `page` back to 1 -- staying on e.g. page 3 of
 * a search whose new term only matches one page would otherwise silently
 * show an empty list.
 */
export function NotesToolbar({
  initialSearch,
  initialSort,
}: {
  initialSearch: string;
  initialSort: NoteSort;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = useState(initialSearch);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stay in sync if the URL changes from elsewhere (browser back/forward,
  // or a link that clears filters) rather than only ever reflecting this
  // component's own edits. Adjusting state during render (React's
  // documented "you might not need an effect" pattern -- comparing against
  // a mirrored previous-props value) rather than in a useEffect: a
  // setState-in-effect here would trigger a redundant extra render on every
  // navigation for no benefit an effect actually needs (no external system
  // to synchronize with -- initialSearch already comes from React/the URL).
  const [prevInitialSearch, setPrevInitialSearch] = useState(initialSearch);
  if (initialSearch !== prevInitialSearch) {
    setPrevInitialSearch(initialSearch);
    setSearchValue(initialSearch);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function pushParams(next: { q?: string; sort?: NoteSort }) {
    const params = new URLSearchParams(searchParams.toString());

    if (next.q !== undefined) {
      if (next.q) params.set("q", next.q);
      else params.delete("q");
    }
    if (next.sort !== undefined) {
      if (next.sort !== DEFAULT_NOTE_SORT) params.set("sort", next.sort);
      else params.delete("sort");
    }
    params.delete("page");

    const qs = params.toString();
    // replace (not push): a search keystroke or sort change is filtering
    // the current view, not navigating somewhere new -- doesn't need its
    // own browser-history entry the way moving to a different page does
    // (components/notes/notes-pagination.tsx uses real <Link>s for that).
    router.replace(qs ? `/notes?${qs}` : "/notes", { scroll: false });
  }

  function handleSearchChange(value: string) {
    setSearchValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushParams({ q: value.trim() });
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleSortChange(value: unknown) {
    pushParams({ sort: parseSortValue(value) });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1.5 sm:max-w-xs sm:flex-1">
        <Label htmlFor="notes-search">Search notes</Label>
        <Input
          id="notes-search"
          type="search"
          placeholder="Search by title or body..."
          value={searchValue}
          onChange={(event) => handleSearchChange(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="notes-sort">Sort</Label>
        <Select value={initialSort} onValueChange={handleSortChange}>
          <SelectTrigger id="notes-sort" className="w-44" aria-label="Sort notes">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NOTE_SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function parseSortValue(value: unknown): NoteSort {
  return value === "oldest" || value === "title_asc" ? value : "newest";
}
