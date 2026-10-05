import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  assertOrgMember,
  assertRole,
  getOrgIdForDocument,
  getPrimaryOrgId,
} from "./auth.server";

export type DocumentRow = {
  id: string;
  filename: string;
  status: string;
  byte_size: number;
  page_count: number | null;
  created_at: string;
  status_updated_at: string;
  failure_reason: string | null;
};

export const listDocuments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) return { documents: [] as DocumentRow[] };
    const { data, error } = await supabase
      .from("documents")
      .select("id, filename, status, byte_size, page_count, created_at, status_updated_at, failure_reason")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { documents: (data ?? []) as DocumentRow[] };
  });

export const getDocument = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    const { supabase } = context;
    const { data: doc, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!doc) throw new Error("Document not found");
    return { document: doc };
  });

const sanitizeFilename = (f: string) =>
  f.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 200) || "document.pdf";

export const createSignedUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        filename: z.string().min(1).max(255),
        byte_size: z.number().int().nonnegative().max(500 * 1024 * 1024),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) throw new Error("No organization");
    await assertRole(supabase, userId, orgId, ["admin", "analyst"]);

    const docId = crypto.randomUUID();
    const clean = sanitizeFilename(data.filename);
    const storagePath = `${orgId}/${docId}/${clean}`;

    const { data: signed, error: signErr } = await supabase.storage
      .from("documents")
      .createSignedUploadUrl(storagePath);
    if (signErr) throw new Error(signErr.message);

    const { error: insErr } = await supabase.from("documents").insert({
      id: docId,
      org_id: orgId,
      storage_path: storagePath,
      filename: clean,
      byte_size: data.byte_size,
      uploaded_by: userId,
      status: "uploaded",
    });
    if (insErr) throw new Error(insErr.message);

    return {
      document_id: docId,
      storage_path: storagePath,
      signed_upload_url: signed.signedUrl,
      token: signed.token,
    };
  });

export const finalizeUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ document_id: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const orgId = await getOrgIdForDocument(supabase, data.document_id);
    await assertOrgMember(supabase, userId, orgId);

    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("id", data.document_id)
      .maybeSingle();
    if (docErr) throw new Error(docErr.message);
    if (!doc) throw new Error("Document not found");

    // Verify object exists in storage
    const parts = doc.storage_path.split("/");
    const dir = parts.slice(0, -1).join("/");
    const name = parts[parts.length - 1];
    const { data: listed, error: listErr } = await supabase.storage
      .from("documents")
      .list(dir, { limit: 1, search: name });
    if (listErr) throw new Error(listErr.message);
    const obj = listed?.find((o) => o.name === name);
    if (!obj) throw new Error("Upload not found in storage");

    // Enforce server-side PDF MIME type (client `accept` is trivially bypassed).
    const meta = (obj.metadata ?? null) as { size?: number; mimetype?: string } | null;
    const mime = meta?.mimetype ?? "";
    if (mime !== "application/pdf") {
      // Remove the rejected object so storage doesn't accumulate bad uploads.
      await supabase.storage.from("documents").remove([doc.storage_path]);
      await supabase
        .from("documents")
        .update({ status: "failed", failure_reason: `Invalid file type: ${mime || "unknown"} (expected application/pdf)` })
        .eq("id", data.document_id);
      throw new Error("Only PDF files are accepted");
    }

    const byteSize = meta?.size ?? 0;
    if (byteSize > 500 * 1024 * 1024) {
      await supabase.storage.from("documents").remove([doc.storage_path]);
      await supabase
        .from("documents")
        .update({ status: "failed", failure_reason: "File exceeds 500 MB limit" })
        .eq("id", data.document_id);
      throw new Error("File exceeds 500 MB limit");
    }
    const { error: updErr } = await supabase
      .from("documents")
      .update({ byte_size: byteSize })
      .eq("id", data.document_id);
    if (updErr) throw new Error(updErr.message);

    return { ok: true, byte_size: byteSize };
  });

export const dispatchExtractionJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ document_id: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { document_id: documentId } = data;

    // Idempotency guard
    const { data: existing } = await supabase
      .from("extraction_jobs")
      .select("id, status")
      .eq("document_id", documentId)
      .in("status", ["pending", "dispatched", "running"])
      .maybeSingle();
    if (existing) return { job_id: existing.id, signed_url: "" };

    try {
      const { data: doc, error: docErr } = await supabase
        .from("documents")
        .select("id, org_id, storage_path, status")
        .eq("id", data.document_id)
        .maybeSingle();
      if (docErr) throw new Error(docErr.message);
      if (!doc) throw new Error("Document not found");

      await assertRole(supabase, userId, doc.org_id, ["admin", "analyst"]);

      // Use admin client for storage signing: the user client can throw non-StorageError
      // exceptions (e.g. network failures) in CF Workers that Seroval can't serialize.
      const { data: signed, error: signErr } = await supabaseAdmin.storage
        .from("documents")
        .createSignedUrl(doc.storage_path, 3600);
      if (signErr) throw new Error(signErr.message);
      if (!signed) throw new Error("Storage: failed to create signed URL");

      const { data: job, error: jobErr } = await supabase
        .from("extraction_jobs")
        .insert({
          document_id: doc.id,
          org_id: doc.org_id,
          status: "pending",
        })
        .select("id")
        .single();
      if (jobErr) throw new Error(jobErr.message);

      const { error: updErr } = await supabase
        .from("documents")
        .update({ extraction_job_id: job.id, status: "extracting" })
        .eq("id", doc.id);
      if (updErr) throw new Error(updErr.message);

      // Use admin client — "members insert audit" policy was dropped in migration 3;
      // direct user inserts are now rejected by RLS. Trigger covers status-change events;
      // this entry records the dispatch action explicitly.
      await supabaseAdmin.from("audit_logs").insert({
        org_id: doc.org_id,
        actor_user_id: userId,
        action: "extraction_dispatched",
        target_type: "document",
        target_id: doc.id,
        payload: { job_id: job.id },
      });

      // Fetch webhook secret for HMAC signing
      const { data: secretRow, error: secretErr } = await supabaseAdmin
        .from("webhook_secrets")
        .select("secret_value")   // verify actual column name vs secret_hash in migration
        .eq("org_id", doc.org_id)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (secretErr || !secretRow) throw new Error("No active webhook secret for org");

      const workerHost = process.env.WORKER_HOST ?? "https://spireclaim.workers.dev";
      const makeWebhookUrl = process.env.MAKE_COM_WEBHOOK_URL;
      if (!makeWebhookUrl) throw new Error("MAKE_COM_WEBHOOK_URL not set");

      const dispatchPayload = {
        job_id: job.id,
        document_id: doc.id,
        org_id: doc.org_id,
        signed_url: signed.signedUrl,   // increase TTL to 3600s (see below)
        callback_url: `${workerHost}/api/public/extraction-callback`,
        webhook_secret: secretRow.secret_value,
      };

      const makeResp = await fetch(makeWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dispatchPayload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!makeResp.ok) {
        const err = await makeResp.text().catch(() => "unknown");
        throw new Error(`Make.com dispatch HTTP ${makeResp.status}: ${err}`);
      }

      await supabaseAdmin.from("extraction_jobs")
        .update({ dispatched_to: "make_com", dispatch_payload: { job_id: job.id } })
        .eq("id", job.id);

      return { job_id: job.id, signed_url: signed.signedUrl };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg);
    }
  });

export const listClaims = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ document_id: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    const { supabase } = context;
    const { data: claims, error } = await supabase
      .from("claims")
      .select("id, page_num, raw_text, normalized_value, unit, category, char_start, char_end")
      .eq("document_id", data.document_id)
      .order("page_num");
    if (error) throw new Error(error.message);
    return { claims: claims ?? [] };
  });

export const submitReviewDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        validation_id: z.string().uuid(),
        before: z.record(z.string(), z.unknown()).optional(),
        after: z.record(z.string(), z.unknown()),
        reason: z.string().max(2000).optional(),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: v, error: vErr } = await supabase
      .from("validations")
      .select("org_id")
      .eq("id", data.validation_id)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!v) throw new Error("Validation not found");
    await assertRole(supabase, userId, v.org_id, ["admin", "analyst"]);

    const { error: insErr } = await supabase.from("human_corrections").insert({
      validation_id: data.validation_id,
      org_id: v.org_id,
      user_id: userId,
      before: (data.before ?? null) as never,
      after: (data.after ?? null) as never,
      reason: data.reason ?? null,
    });
    if (insErr) throw new Error(insErr.message);

    await supabaseAdmin.from("audit_logs").insert({
      org_id: v.org_id,
      actor_user_id: userId,
      action: "review_decision",
      target_type: "validation",
      target_id: data.validation_id,
      payload: { reason: data.reason ?? null },
    });

    // Phase 5: Feedback Loop to the ML service
    const { data: val } = await supabase
      .from("validations")
      .select("embedding, taxonomy_node_id, confidence")
      .eq("id", data.validation_id)
      .single();

    if (val?.embedding) {
      const mlUrl = process.env.VERIGREEN_ML_URL;
      const apiKey = process.env.ML_SERVICE_API_KEY;
      if (mlUrl && apiKey) {
        // We assume 'after' contains the new taxonomy_node_id if changed
        const newTaxonomyNodeId = (data.after.taxonomy_node_id as string) || val.taxonomy_node_id;
        
        await fetch(`${mlUrl}/feedback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            validation_id: data.validation_id,
            claim_embedding: val.embedding,
            correct_node_id: newTaxonomyNodeId,
            wrong_node_id: val.taxonomy_node_id,
            system_score: val.confidence,
            system_correct: (newTaxonomyNodeId === val.taxonomy_node_id),
            org_id: v.org_id,
          }),
        }).catch((err) => console.error("Feedback loop failed:", err));
      }
    }

    return { ok: true };
  });
