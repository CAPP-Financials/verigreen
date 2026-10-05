/**
 * HITL review queue — Day-7.
 *
 * Handles human-in-the-loop review of claims that the ML pipeline routed to
 * `pending_review` (low-confidence taxonomy match or adversarial flags detected).
 *
 * Functions:
 *   listReviewQueue     — list pending items with optional adversarial filter
 *   assignReviewItem    — assign an item to a specific analyst
 *   resolveReviewItem   — approve/reject → update status + write human_corrections
 *   reclassifyValidation — change taxonomy node + write human_corrections
 *
 * All writes to human_corrections feed the Day-8 calibration pipeline.
 * validations.status is TEXT so no enum changes needed.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole, getPrimaryOrgId } from "./auth.server";

const PENDING_STATUSES = ["pending_review"] as const;
const REVIEW_DECISIONS = ["human_approved", "human_rejected"] as const;

// ─── List ─────────────────────────────────────────────────────────────────────

export const listReviewQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        adversarial_only: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(200).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) return { items: [], total: 0 };

    // Analysts and above can see the queue; viewer role is read-only elsewhere
    await assertRole(supabase, userId, orgId, ["admin", "analyst"]);

    let query = supabase
      .from("validations")
      .select(
        `id, claim_id, status, confidence, substantiation_score,
         substantiation_indicators, adversarial_indicators,
         assigned_to, reviewed_at, taxonomy_node_id, created_at,
         claims!inner(raw_text, page_num, category, document_id)`,
        { count: "exact" },
      )
      .eq("org_id", orgId)
      .in("status", [...PENDING_STATUSES])
      .order("created_at", { ascending: true })
      .range(data.offset, data.offset + data.limit - 1);

    // Narrow to adversarial-flagged items when requested
    if (data.adversarial_only) {
      query = query.not("adversarial_indicators", "is", null);
    }

    const { data: items, error, count } = await query;
    if (error) throw new Error(error.message);
    return { items: items ?? [], total: count ?? 0 };
  });

// ─── Assign ───────────────────────────────────────────────────────────────────

export const assignReviewItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        validation_id: z.string().uuid(),
        assign_to_user_id: z.string().uuid().nullable(),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: v, error: vErr } = await supabase
      .from("validations")
      .select("org_id, status")
      .eq("id", data.validation_id)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!v) throw new Error("Validation not found");
    await assertRole(supabase, userId, v.org_id, ["admin", "analyst"]);

    const { error } = await supabase
      .from("validations")
      .update({ assigned_to: data.assign_to_user_id })
      .eq("id", data.validation_id)
      .in("status", [...PENDING_STATUSES]);
    if (error) throw new Error(error.message);

    return { ok: true };
  });

// ─── Resolve ──────────────────────────────────────────────────────────────────

export const resolveReviewItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        validation_id: z.string().uuid(),
        decision: z.enum(REVIEW_DECISIONS),
        reason: z.string().max(2000).optional(),
        before: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: v, error: vErr } = await supabase
      .from("validations")
      .select("org_id, status, confidence, taxonomy_node_id")
      .eq("id", data.validation_id)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!v) throw new Error("Validation not found");
    await assertRole(supabase, userId, v.org_id, ["admin", "analyst"]);

    const now = new Date().toISOString();

    // Update validation: new status + reviewer metadata
    const { error: updateErr } = await supabase
      .from("validations")
      .update({ status: data.decision, reviewed_at: now, assigned_to: userId })
      .eq("id", data.validation_id);
    if (updateErr) throw new Error(updateErr.message);

    // Write correction record — feeds Day-8 calibration
    const before = data.before ?? { status: v.status, confidence: v.confidence };
    const { error: corrErr } = await supabase.from("human_corrections").insert({
      validation_id: data.validation_id,
      org_id: v.org_id,
      user_id: userId,
      before: before as never,
      after: { status: data.decision } as never,
      reason: data.reason ?? null,
    });
    if (corrErr) throw new Error(corrErr.message);


    await supabaseAdmin.from("audit_logs").insert({
      org_id: v.org_id,
      actor_user_id: userId,
      action: "review_resolved",
      target_type: "validation",
      target_id: data.validation_id,
      payload: { decision: data.decision, reason: data.reason ?? null },
    });

    return { ok: true };
  });

// ─── Reclassify ───────────────────────────────────────────────────────────────

export const reclassifyValidation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        validation_id: z.string().uuid(),
        new_taxonomy_node_id: z.string().uuid().nullable(),
        new_status: z.enum(["human_approved", "unmapped"]).optional().default("human_approved"),
        reason: z.string().max(2000).optional(),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: v, error: vErr } = await supabase
      .from("validations")
      .select("org_id, taxonomy_node_id, status, confidence")
      .eq("id", data.validation_id)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!v) throw new Error("Validation not found");
    await assertRole(supabase, userId, v.org_id, ["admin", "analyst"]);

    const now = new Date().toISOString();

    const { error: updateErr } = await supabase
      .from("validations")
      .update({
        taxonomy_node_id: data.new_taxonomy_node_id,
        status: data.new_status,
        reviewed_at: now,
        assigned_to: userId,
      })
      .eq("id", data.validation_id);
    if (updateErr) throw new Error(updateErr.message);

    const { error: corrErr } = await supabase.from("human_corrections").insert({
      validation_id: data.validation_id,
      org_id: v.org_id,
      user_id: userId,
      before: { taxonomy_node_id: v.taxonomy_node_id, status: v.status },
      after: { taxonomy_node_id: data.new_taxonomy_node_id, status: data.new_status },
      reason: data.reason ?? null,
    });
    if (corrErr) throw new Error(corrErr.message);

    await supabaseAdmin.from("audit_logs").insert({
      org_id: v.org_id,
      actor_user_id: userId,
      action: "validation_reclassified",
      target_type: "validation",
      target_id: data.validation_id,
      payload: {
        old_taxonomy_node_id: v.taxonomy_node_id,
        new_taxonomy_node_id: data.new_taxonomy_node_id,
        reason: data.reason ?? null,
      },
    });

    return { ok: true };
  });
