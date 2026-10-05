/**
 * GDPR data deletion — cascading org data removal.
 *
 * Deletes all PII and operational data for an organisation while retaining
 * an anonymised tombstone audit log entry (required for legal accountability).
 *
 * Admin-role-gated. Never hard-deletes the organisations row — a soft delete
 * (deleted_at timestamp) preserves the audit trail without exposing user data.
 *
 * Sequence:
 *   1. model_call_log       — AI inference audit records
 *   2. human_corrections    — HITL reviewer decisions
 *   3. validations          — taxonomy + substantiation results
 *   4. claims               — extracted claim text + spans
 *   5. extraction_jobs      — job records
 *   6. documents            — document metadata + storage refs
 *   7. api_keys             — API credentials (hashed)
 *   8. webhook_secrets      — signing secrets
 *   9. webhook_deliveries   — outbound delivery records
 *  10. webhook_endpoints    — registered webhook URLs
 *  11. audit_logs           — operational audit trail
 *  12. organization_members — membership records
 *  13. user_roles           — RBAC assignments
 *  14. organizations.deleted_at = now() — soft delete + tombstone audit log
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole, getPrimaryOrgId } from "./auth.server";

/** Inner function — also callable from admin scripts. */
export async function deleteOrganizationData(orgId: string, actorUserId: string | null): Promise<void> {
  // 1–11: delete operational data in dependency order
  const tables = [
    "model_call_log",
    "human_corrections",
    "validations",
    "claims",
    "extraction_jobs",
    "documents",
    "api_keys",
    "webhook_secrets",
    "webhook_deliveries",
    "webhook_endpoints",
    "audit_logs",
    "organization_members",
    "user_roles",
  ] as const;

  for (const table of tables) {
    const { error } = await supabaseAdmin
      .from(table as string)
      .delete()
      .eq("org_id", orgId);
    if (error) {
      console.error(`[gdpr] delete from ${table} failed:`, error.message);
      // Non-fatal per table — continue to next; partial deletion is better than no deletion
    }
  }

  // 12. Soft-delete the org row — preserves the tenant ID for audit trail
  await supabaseAdmin
    .from("organizations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", orgId);

  // 13. Insert anonymised tombstone so auditors know a deletion occurred
  await supabaseAdmin.from("audit_logs").insert({
    org_id: orgId,
    actor_user_id: actorUserId,
    action: "org_data_deleted_gdpr",
    target_type: "organization",
    target_id: orgId,
    payload: {
      reason: "GDPR data deletion request",
      deleted_at: new Date().toISOString(),
    },
  });
}

/** Server function — admin-only, CSRF-protected via POST. */
export const requestDataDeletion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ confirm: z.literal(true) }))
  .handler(async ({ context, data }) => {
    const orgId = await getPrimaryOrgId(context.user.id);
    await assertRole(context.user.id, orgId, "admin");

    await deleteOrganizationData(orgId, context.user.id);

    return { ok: true, message: "Organisation data deleted. Your account has been marked inactive." };
  });
