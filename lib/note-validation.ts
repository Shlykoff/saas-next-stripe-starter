// Pure, framework-free validation shared by the create/update note Server
// Actions (app/actions/notes.ts) -- kept separate, with no imports, so
// "empty/too-long title" is directly unit-testable with no DB and no
// Next.js request context, same rationale as lib/subscription-access.ts.
//
// Not DB constraints (supabase/migrations/20260817212642_add_notes.sql only
// requires `title` to be non-null) -- these are our own UX guards. Keep in
// sync with the `maxLength` attributes on the note forms
// (components/notes/create-note-form.tsx, components/notes/note-item.tsx)
// if changed.
export const MAX_NOTE_TITLE_LENGTH = 200;
export const MAX_NOTE_BODY_LENGTH = 20_000;

/** Returns an error message if `title` is invalid, or null if it's fine. */
export function validateNoteTitle(title: string): string | null {
  if (title.length === 0) return "Title is required.";
  if (title.length > MAX_NOTE_TITLE_LENGTH) {
    return `Title is too long (max ${MAX_NOTE_TITLE_LENGTH} characters).`;
  }
  return null;
}

/** Returns an error message if `body` is invalid, or null if it's fine. */
export function validateNoteBody(body: string): string | null {
  if (body.length > MAX_NOTE_BODY_LENGTH) {
    return `Note is too long (max ${MAX_NOTE_BODY_LENGTH} characters).`;
  }
  return null;
}
