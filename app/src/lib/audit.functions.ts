/**
 * Audit log export — CSV and JSON download for compliance and customer audits.
 *
 * RLS-scoped: only exports rows for the caller's organisation.
 * Admin or analyst role required (read-only, non-destructive).
 *
 * JSON format: array of audit_logs rows.
 * CSV format: flat columns matching the audit_logs schema.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole, getPrimaryOrgId } from "./auth.server";

const ExportParamsSchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  since: z.string().datetime().optional(),   // ISO datetime lower bound
  limit: z.number().int().min(1).max(10000).default(1000),
});

type AuditRow = {
  id: string;
  org_id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

function rowsToCsv(rows: AuditRow[]): string {
  const headers = ["id", "org_id", "actor_user_id", "action", "target_type", "target_id", "payload", "created_at"];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // RFC 4180 CSV escaping
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      headers.map((h) => escape((r as Record<string, unknown>)[h])).join(",")
    ),
  ];
  return lines.join("\n");
}

/** Server function — analyst or admin role required. */
export const exportAuditLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator(ExportParamsSchema)
  .handler(async ({ context, data }) => {
    const orgId = await getPrimaryOrgId(context.user.id);
    // Analyst role is sufficient for read-only export
    await assertRole(context.user.id, orgId, "analyst");

    let query = supabaseAdmin
      .from("audit_logs")
      .select("id, org_id, actor_user_id, action, target_type, target_id, payload, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (data.since) {
      query = query.gte("created_at", data.since);
    }

    const { data: rows, error } = await query;
    if (error) {
      throw new Error(`Audit log query failed: ${error.message}`);
    }

    const typedRows = (rows ?? []) as AuditRow[];

    if (data.format === "csv") {
      return {
        content: rowsToCsv(typedRows),
        contentType: "text/csv",
        filename: `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
        rows: typedRows.length,
      };
    }

    return {
      content: JSON.stringify(typedRows, null, 2),
      contentType: "application/json",
      filename: `audit-log-${new Date().toISOString().slice(0, 10)}.json`,
      rows: typedRows.length,
    };
  });
