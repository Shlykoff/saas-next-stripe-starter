import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "./supabase/database.types";

export type SubscriptionRow = Tables<"subscriptions">;

/**
 * Reads an organization's subscription mirror row. Goes through the
 * session-bound (anon-key) client, so this is subject to
 * "subscriptions_select_members" RLS -- returns null both when there is
 * genuinely no subscriptions row yet (org never checked out) AND when the
 * caller isn't actually a member of organizationId (RLS silently returns
 * zero rows rather than an error), which is exactly the behavior every
 * caller here wants: never distinguish "no subscription" from "not your
 * org" to the end user.
 */
export async function getOrganizationSubscription(
  supabase: SupabaseClient<Database>,
  organizationId: string,
): Promise<SubscriptionRow | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load subscription: ${error.message}`);
  }

  return data;
}
