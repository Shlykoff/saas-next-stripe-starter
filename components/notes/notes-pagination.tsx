import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DEFAULT_NOTE_SORT, type NoteSort } from "@/lib/notes";

/**
 * Previous/Next pager for /notes. Deliberately a Server Component using
 * real <Link>s (not a client component driving router.push) -- pagination
 * is genuine navigation between distinct views of the list (unlike
 * components/notes/notes-toolbar.tsx's search/sort, which is filtering the
 * current view), so it gets real URLs, browser-history entries, prefetch,
 * and works with JS disabled, for free.
 */
export function NotesPagination({
  page,
  totalPages,
  totalCount,
  pageSize,
  currentCount,
  search,
  sort,
}: {
  page: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
  /** Number of notes actually rendered on this page (for the "Showing X-Y of N" caption). */
  currentCount: number;
  search: string;
  sort: NoteSort;
}) {
  if (totalCount === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = from + currentCount - 1;

  return (
    <nav aria-label="Notes pagination" className="flex flex-col items-center gap-2 pt-2 sm:flex-row sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Showing {from}–{to} of {totalCount}
      </p>
      <div className="flex items-center gap-2">
        <PageLink page={page - 1} disabled={page <= 1} search={search} sort={sort} label="Previous" />
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <PageLink page={page + 1} disabled={page >= totalPages} search={search} sort={sort} label="Next" />
      </div>
    </nav>
  );
}

function PageLink({
  page,
  disabled,
  search,
  sort,
  label,
}: {
  page: number;
  disabled: boolean;
  search: string;
  sort: NoteSort;
  label: string;
}) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none opacity-50")}
      >
        {label}
      </span>
    );
  }

  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (sort !== DEFAULT_NOTE_SORT) params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();

  return (
    <Link href={qs ? `/notes?${qs}` : "/notes"} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
      {label}
    </Link>
  );
}
