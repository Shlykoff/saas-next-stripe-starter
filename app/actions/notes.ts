"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateNoteTitle, validateNoteBody } from "@/lib/note-validation";

export interface NoteActionState {
  error: string | null;
  success?: boolean;
}

/**
 * Server Action backing the "new note" form (components/notes/create-note-
 * form.tsx). Deliberately does NOT re-check organization membership or
 * subscription status here -- RLS policy "notes_insert_members_as_self"
 * (is_org_member(organization_id) AND author_id = auth.uid()) already makes
 * it impossible to insert into an org you don't belong to, and the
 * subscription gate is enforced by app/notes/page.tsx never rendering this
 * form at all for an organization without access (see
 * lib/subscription-access.ts). Duplicating either check here would just be
 * two places that can drift out of sync -- the DB-architect's own comment
 * in the notes migration makes the same call for the billing gate.
 * author_id is always the caller's own auth.uid(), never taken from the
 * form, so there's no way to author a note as someone else.
 */
export async function createNote(
  _prevState: NoteActionState,
  formData: FormData,
): Promise<NoteActionState> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  if (!organizationId) {
    return { error: "Missing organization." };
  }
  const titleError = validateNoteTitle(title);
  if (titleError) return { error: titleError };
  const bodyError = validateNoteBody(body);
  if (bodyError) return { error: bodyError };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { error } = await supabase.from("notes").insert({
    organization_id: organizationId,
    author_id: user.id,
    title,
    body,
  });

  if (error) {
    // Most likely cause of a failure here (given the client-side checks
    // above already ran): the caller isn't actually a member of
    // organizationId and RLS's WITH CHECK rejected the insert -- surfaced
    // as a generic message rather than distinguishing "not a member" from
    // any other DB error, since neither case should ever legitimately be
    // reachable through the real UI (the form only ever renders with the
    // signed-in user's own organization.id).
    return { error: `Could not create note: ${error.message}` };
  }

  revalidatePath("/notes");
  return { error: null, success: true };
}

/**
 * Server Action backing inline note editing (components/notes/note-item.tsx).
 * Authorization is entirely RLS's job (policy "notes_update_author_or_owner":
 * author_id = auth.uid() OR is_org_owner(organization_id)) -- this action
 * does not look up the note first to check who owns it. Instead, `.select()`
 * is chained onto the update so we can tell a genuine "no such note" /
 * "you don't have permission" apart from a real success: an UPDATE that RLS
 * silently filters out (no matching row visible for write) returns 0 rows
 * and NO error from PostgREST, so checking `error` alone would report
 * success for a write that never actually happened.
 */
export async function updateNote(
  _prevState: NoteActionState,
  formData: FormData,
): Promise<NoteActionState> {
  const noteId = String(formData.get("noteId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  if (!noteId) {
    return { error: "Missing note id." };
  }
  const titleError = validateNoteTitle(title);
  if (titleError) return { error: titleError };
  const bodyError = validateNoteBody(body);
  if (bodyError) return { error: bodyError };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("notes")
    .update({ title, body })
    .eq("id", noteId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: `Could not update note: ${error.message}` };
  }
  if (!data) {
    return { error: "Note not found, or you don't have permission to edit it." };
  }

  revalidatePath("/notes");
  return { error: null, success: true };
}

/**
 * Server Action backing the delete button (components/notes/note-item.tsx).
 * Same RLS-only authorization story as updateNote above (policy
 * "notes_delete_author_or_owner"): the `.select()` after `.delete()` is what
 * lets us tell "deleted" apart from "RLS silently matched zero rows".
 */
export async function deleteNote(
  _prevState: NoteActionState,
  formData: FormData,
): Promise<NoteActionState> {
  const noteId = String(formData.get("noteId") ?? "");
  if (!noteId) {
    return { error: "Missing note id." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("notes")
    .delete()
    .eq("id", noteId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: `Could not delete note: ${error.message}` };
  }
  if (!data) {
    return { error: "Note not found, or you don't have permission to delete it." };
  }

  revalidatePath("/notes");
  return { error: null, success: true };
}
