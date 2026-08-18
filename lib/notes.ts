import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "./supabase/database.types";

export type NoteRow = Tables<"notes">;

/**
 * Reads an organization's notes, newest first. Goes through the
 * session-bound (anon-key) client, so this is subject to
 * "notes_select_members" RLS -- returns an empty list both when the org
 * genuinely has no notes yet AND when the caller isn't a member of
 * organizationId (RLS returns zero rows, not an error), same pattern as
 * lib/subscriptions.ts's getOrganizationSubscription.
 */
export async function getOrganizationNotes(
  supabase: SupabaseClient<Database>,
  organizationId: string,
): Promise<NoteRow[]> {
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load notes: ${error.message}`);
  }

  return data ?? [];
}
