/**
 * Batch document dispatch — Day-7.
 *
 * Accepts up to 50 document IDs and dispatches extraction jobs for as many as
 * the per-org concurrency cap allows. Documents beyond the cap are returned as
 * `queued` for the caller to retry later.
 *
 * Concurrency note (pilot-grade): the in-flight count is a non-atomic read.
 * Two simultaneous batchDispatch calls can over-dispatch by at most N jobs.
 * Acceptable for pilot scale; post-launch fix: Postgres advisory lock per org_id.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole, getPrimaryOrgId } from "./auth.server";

const CONCURRENT_JOBS_CAP = 5;

export const batchDispatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        document_ids: z.array(z.string().uuid()).min(1).max(50),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) throw new Error("No organization");
    await assertRole(supabase, userId, orgId, ["admin", "analyst"]);

    // Count currently in-flight jobs for this org
    const { count: inflightCount, error: countErr } = await supabaseAdmin
      .from("extraction_jobs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .in("status", ["pending", "running"]);
    if (countErr) throw new Error(countErr.message);

    const slotsAvailable = Math.max(0, CONCURRENT_JOBS_CAP - (inflightCount ?? 0));
    const toDispatch = data.document_ids.slice(0, slotsAvailable);
    const queuedIds = data.document_ids.slice(slotsAvailable);

    const dispatched: Array<{ document_id: string; job_id: string; signed_url: string }> = [];
    const failed: Array<{ document_id: string; error: string }> = [];

    for (const docId of toDispatch) {
      try {
        // Verify document belongs to this org
        const { data: doc } = await supabase
          .from("documents")
          .select("id, org_id, storage_path, status")
          .eq("id", docId)
          .eq("org_id", orgId)
          .maybeSingle();

        if (!doc) {
          failed.push({ document_id: docId, error: "Not found" });
          continue;
        }
        if (doc.status === "extracting") {
          failed.push({ document_id: docId, error: "Already extracting" });
          continue;
        }

        const { data: signed, error: signErr } = await supabaseAdmin.storage
          .from("documents")
          .createSignedUrl(doc.storage_path, 900);
        if (signErr || !signed) {
          failed.push({ document_id: docId, error: signErr?.message ?? "Signed URL failed" });
          continue;
        }

        const { data: job, error: jobErr } = await supabase
          .from("extraction_jobs")
          .insert({ document_id: doc.id, org_id: doc.org_id, status: "pending" })
          .select("id")
          .single();
        if (jobErr || !job) {
          failed.push({ document_id: docId, error: jobErr?.message ?? "Job insert failed" });
          continue;
        }

        await supabase
          .from("documents")
          .update({ extraction_job_id: job.id, status: "extracting" })
          .eq("id", doc.id);

        dispatched.push({ document_id: docId, job_id: job.id, signed_url: signed.signedUrl });
      } catch (e) {
        failed.push({
          document_id: docId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      actor_user_id: userId,
      action: "batch_dispatch",
      target_type: "extraction_job",
      target_id: null,
      payload: {
        dispatched: dispatched.length,
        queued: queuedIds.length,
        failed: failed.length,
        cap: CONCURRENT_JOBS_CAP,
      },
    });

    return {
      dispatched,
      queued: queuedIds,
      failed,
      slots_used: dispatched.length,
      slots_remaining: slotsAvailable - dispatched.length,
    };
  });
