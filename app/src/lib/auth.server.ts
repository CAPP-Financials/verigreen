/**
 * Server-only auth helpers. Used by server functions to enforce org membership
 * and roles on top of `requireSupabaseAuth`. RLS is the backstop; these are
 * the primary gate.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type AppRole = "admin" | "analyst" | "viewer";

export async function assertOrgMember(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("org_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: not a member of this organization");
}

export async function assertRole(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  roles: AppRole[],
): Promise<void> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .in("role", roles);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(`Forbidden: requires one of [${roles.join(", ")}]`);
  }
}

export async function getOrgIdForDocument(
  supabase: SupabaseClient,
  documentId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("documents")
    .select("org_id")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Document not found");
  return data.org_id as string;
}

export async function getPrimaryOrgId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("org_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.org_id ?? null;
}
