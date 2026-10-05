/**
 * VeriGreen extraction callback — full Day-6 implementation.
 *
 * External ML service (Vercel Fluid Compute) POSTs extraction results here.
 *
 * Auth: HMAC-SHA256 over `${timestamp}.${rawBody}`, verified against the
 * per-org webhook secret in `public.webhook_secrets`. Timestamp binding
 * prevents capture-and-replay attacks (Stripe webhook pattern).
 *   Header: X-VeriGreen-Signature: sha256=<lowercase hex>
 *   Header: X-VeriGreen-Timestamp: <unix seconds, UTC integer>
 *   Freshness window: ±300 s
 *
 * Adversarial Layer 5 — per-tenant context isolation:
 *   The extraction_jobs row is fetched and its org_id is cross-referenced
 *   against payload.organization_id BEFORE any DB writes. Mismatch → 403.
 *   This prevents a compromised ML job from writing claims into a different
 *   tenant's namespace.
 *
 * Payload schema mirrors Python ExtractionResult model (see ml-service/api/models.py).
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { constantTimeEqual, hmacSha256Hex } from "@/lib/crypto.server";
import { deliverExtractionEvent } from "@/lib/webhooks.delivery";

// ─── Payload schemas ──────────────────────────────────────────────────────────

const TaxonomyMappingSchema = z.object({
  node_id: z.string().nullable().optional(),
  framework: z.enum(["GRI", "SASB"]).nullable().optional(),
  code: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  score: z.number().default(0),
  routing: z.enum(["matched", "requires_manual_review", "unmapped"]).default("unmapped"),
});

const SubstantiationIndicatorsSchema = z
  .object({
    vague_language: z.boolean().default(false),
    lacks_quantification: z.boolean().default(false),
    lacks_baseline: z.boolean().default(false),
    lacks_time_bound: z.boolean().default(false),
    lacks_third_party_verification: z.boolean().default(false),
    unverified_third_party_claim: z.boolean().default(false),
    unverified_authority: z.string().nullable().optional(),
    has_known_verifier: z.boolean().default(false),
    suspiciously_perfect_score: z.boolean().default(false),
    has_imperative_spans: z.boolean().default(false),
    has_encoded_content: z.boolean().default(false),
  })
  .passthrough();

const SubstantiationResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  indicators: SubstantiationIndicatorsSchema.default({}),
  disclaimer: z.string().default(""),
  requires_manual_review: z.boolean().default(false),
});

const ClaimSchema = z.object({
  raw_text: z.string(),
  page_num: z.number().int(),
  char_start: z.number().int(),
  char_end: z.number().int(),
  normalized_value: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  category: z
    .enum(["emissions", "energy", "water", "waste", "other"])
    .nullable()
    .optional(),
  normalized_value_uncertain: z.boolean().default(false),
  min_value: z.number().nullable().optional(),
  max_value: z.number().nullable().optional(),
  taxonomy: TaxonomyMappingSchema.nullable().optional(),
  substantiation: SubstantiationResultSchema.nullable().optional(),
  claim_embedding: z.array(z.number()).nullable().optional(),
  gemini_validation: z.object({
    valid: z.boolean(),
    confidence: z.number(),
    rejection_reason: z.string().nullable().optional(),
  }).nullable().optional(),
});

const AdversarialIndicatorsSchema = z
  .object({
    has_direct_injection: z.boolean().default(false),
    has_jailbreak_attempt: z.boolean().default(false),
    has_encoded_payload: z.boolean().default(false),
    has_exfiltration_attempt: z.boolean().default(false),
    has_system_prompt_leak_attempt: z.boolean().default(false),
    has_authority_impersonation: z.boolean().default(false),
    has_hidden_text: z.boolean().default(false),
    detected_vectors: z.array(z.string()).default([]),
  })
  .passthrough();

const MetricsSchema = z
  .object({
    tokens_in: z.number().int().default(0),
    tokens_out: z.number().int().default(0),
    duration_ms: z.number().int().default(0),
    model_calls: z.number().int().default(0),
    escalated: z.boolean().default(false),
    passes: z.number().int().default(0),
  })
  .passthrough();

// Adversarial Layer 8: per-call model audit log entries from the ML service
const ModelCallLogEntrySchema = z.object({
  model_id: z.string(),
  system_prompt_hash: z.string().length(64),  // sha256 hex
  user_message_hash: z.string().length(64),
  output_hash: z.string().length(64),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  duration_ms: z.number().int(),
});

const CallbackPayloadSchema = z.object({
  job_id: z.string().uuid(),
  document_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  status: z.enum(["complete", "partial", "failed"]),
  claims: z.array(ClaimSchema).default([]),
  adversarial_indicators: AdversarialIndicatorsSchema.default({}),
  metrics: MetricsSchema.default({}),
  model_call_logs: z.array(ModelCallLogEntrySchema).default([]),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .optional(),
});

type CallbackPayload = z.infer<typeof CallbackPayloadSchema>;

// ─── Route handler ────────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/public/extraction-callback")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();

        // ── Timestamp freshness check ────────────────────────────────────────
        const tsHeader = request.headers.get("x-verigreen-timestamp") ?? "";
        if (!/^\d+$/.test(tsHeader)) {
          return new Response("Invalid timestamp header", { status: 401 });
        }
        const timestamp = parseInt(tsHeader, 10);
        const nowSec = Math.floor(Date.now() / 1000);
        if (Math.abs(nowSec - timestamp) > 300) {
          return new Response("Stale request", { status: 401 });
        }

        // ── Signature format check ───────────────────────────────────────────
        const sigHeader = request.headers.get("x-verigreen-signature") ?? "";
        if (!sigHeader.startsWith("sha256=")) {
          return new Response("Invalid signature header", { status: 401 });
        }
        const presented = sigHeader.slice("sha256=".length).trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(presented)) {
          return new Response("Invalid signature format", { status: 401 });
        }

        // ── Parse org_id from body (needed to look up secret) ────────────────
        let orgId: string;
        try {
          const raw = JSON.parse(rawBody);
          orgId = z.object({ organization_id: z.string().uuid() }).parse(raw).organization_id;
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }

        // ── Look up active webhook secrets for this org ───────────────────────
        const { data: secrets, error: secErr } = await supabaseAdmin
          .from("webhook_secrets")
          .select("id, secret_value, revoked_at")
          .eq("org_id", orgId)
          .is("revoked_at", null);
        if (secErr) {
          console.error("webhook_secrets lookup failed", secErr);
          return new Response("Internal error", { status: 500 });
        }
        if (!secrets?.length) {
          return new Response("No active webhook secret", { status: 401 });
        }

        // ── HMAC verification (constant-time) ────────────────────────────────
        const signedPayload = `${timestamp}.${rawBody}`;
        let matched = false;
        for (const s of secrets) {
          const expected = await hmacSha256Hex(s.secret_value, signedPayload);
          if (constantTimeEqual(presented, expected)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          return new Response("Signature mismatch", { status: 401 });
        }

        // ── Full payload validation ──────────────────────────────────────────
        let payload: CallbackPayload;
        try {
          payload = CallbackPayloadSchema.parse(JSON.parse(rawBody));
        } catch (err) {
          return new Response("Payload schema error", { status: 400 });
        }

        // ── Adversarial Layer 5: cross-tenant isolation check ────────────────
        // Fetch the extraction job and verify it belongs to the claimed org.
        // This prevents a compromised ML job writing claims into another tenant.
        const { data: job, error: jobErr } = await supabaseAdmin
          .from("extraction_jobs")
          .select("id, org_id, document_id")
          .eq("id", payload.job_id)
          .maybeSingle();
        if (jobErr || !job) {
          return new Response("Job not found", { status: 404 });
        }
        if (job.org_id !== payload.organization_id) {
          console.error(
            `[Layer5] org mismatch: job ${job.id} org=${job.org_id} payload org=${payload.organization_id}`,
          );
          return new Response("Organization mismatch", { status: 403 });
        }
        if (job.document_id !== payload.document_id) {
          return new Response("Document mismatch", { status: 400 });
        }

        // ── Persist claims + validations ─────────────────────────────────────
        const now = new Date().toISOString();
        let claimsInserted = 0;
        let adversarialDetected = false;

        for (const claim of payload.claims) {
          // Check for adversarial flags in this claim (Layer 6/7)
          const sub = claim.substantiation;
          if (
            sub?.indicators.has_imperative_spans ||
            sub?.indicators.has_encoded_content ||
            sub?.indicators.unverified_third_party_claim
          ) {
            adversarialDetected = true;
          }

          const { data: claimRow, error: claimErr } = await supabaseAdmin
            .from("claims")
            .insert({
              document_id: payload.document_id,
              org_id: payload.organization_id,
              page_num: claim.page_num,
              char_start: claim.char_start,
              char_end: claim.char_end,
              raw_text: claim.raw_text,
              normalized_value: claim.normalized_value ?? null,
              unit: claim.unit ?? null,
              category: claim.category ?? null,
              normalized_value_uncertain: claim.normalized_value_uncertain,
              min_value: claim.min_value ?? null,
              max_value: claim.max_value ?? null,
            })
            .select("id")
            .single();

          if (claimErr || !claimRow) {
            console.error("[callback] claim insert failed:", claimErr?.message);
            continue;
          }
          claimsInserted++;

          // Insert validation record (always, for any routing tier)
          if (claim.taxonomy) {
            let taxonomyNodeId: string | null = null;

            // Look up pre-seeded taxonomy node UUID
            if (claim.taxonomy.framework && claim.taxonomy.code) {
              const { data: txNode } = await supabaseAdmin
                .from("taxonomy_nodes")
                .select("id")
                .eq("framework", claim.taxonomy.framework.toLowerCase() as "gri" | "sasb")
                .eq("code", claim.taxonomy.code)
                .eq("version", "v1")
                .maybeSingle();
              taxonomyNodeId = txNode?.id ?? null;

              // Fallback upsert if not pre-seeded (future taxonomy versions)
              if (!taxonomyNodeId && claim.taxonomy.label) {
                const { data: upserted } = await supabaseAdmin
                  .from("taxonomy_nodes")
                  .upsert(
                    {
                      framework: claim.taxonomy.framework.toLowerCase() as "gri" | "sasb",
                      code: claim.taxonomy.code,
                      name: claim.taxonomy.label,
                      version: "v1",
                    },
                    { onConflict: "framework,code,version" },
                  )
                  .select("id")
                  .single();
                taxonomyNodeId = upserted?.id ?? null;
              }
            }

            const validationStatus =
              claim.taxonomy.routing === "matched"
                ? "auto_approved"
                : claim.taxonomy.routing === "requires_manual_review"
                  ? "pending_review"
                  : "unmapped";

            const adversarialFlags = {
              has_imperative_spans: sub?.indicators.has_imperative_spans ?? false,
              has_encoded_content: sub?.indicators.has_encoded_content ?? false,
              unverified_third_party_claim:
                sub?.indicators.unverified_third_party_claim ?? false,
              suspiciously_perfect_score:
                sub?.indicators.suspiciously_perfect_score ?? false,
            };

            await supabaseAdmin.from("validations").insert({
              claim_id: claimRow.id,
              org_id: payload.organization_id,
              taxonomy_node_id: taxonomyNodeId,
              taxonomy_version: "v1",
              model_id: "heuristic-v1",
              confidence: claim.taxonomy.score,
              status: validationStatus,
              substantiation_score: sub?.score ?? null,
              substantiation_indicators: (sub?.indicators ?? null) as never,
              adversarial_indicators: adversarialFlags as never,
              embedding: claim.claim_embedding ?? null,
              gemini_valid: claim.gemini_validation?.valid ?? null,
              gemini_confidence: claim.gemini_validation?.confidence ?? null,
              gemini_rejection_reason: claim.gemini_validation?.rejection_reason ?? null,
            });
          }
        }

        // ── Update extraction_jobs ────────────────────────────────────────────
        const jobStatus: "complete" | "failed" =
          payload.status === "failed" ? "failed" : "complete";
        await supabaseAdmin
          .from("extraction_jobs")
          .update({
            status: jobStatus,
            completed_at: now,
            tokens_in: payload.metrics.tokens_in,
            tokens_out: payload.metrics.tokens_out,
            error_message: payload.error?.message ?? null,
          })
          .eq("id", payload.job_id);

        // ── Update documents ──────────────────────────────────────────────────
        const docStatus: "complete" | "failed" | "partial" =
          payload.status === "failed"
            ? "failed"
            : payload.status === "partial"
              ? "complete"  // partial = some pages processed; mark complete at document level
              : "complete";
        await supabaseAdmin
          .from("documents")
          .update({
            status: docStatus,
            failure_reason: payload.error?.message ?? null,
          })
          .eq("id", payload.document_id);

        // ── Audit log ─────────────────────────────────────────────────────────
        await supabaseAdmin.from("audit_logs").insert({
          org_id: payload.organization_id,
          actor_user_id: null,
          action: "extraction_callback_processed",
          target_type: "extraction_job",
          target_id: payload.job_id,
          payload: {
            status: payload.status,
            claims_inserted: claimsInserted,
            tokens_in: payload.metrics.tokens_in,
            tokens_out: payload.metrics.tokens_out,
            adversarial_detected:
              adversarialDetected ||
              (payload.adversarial_indicators.detected_vectors?.length ?? 0) > 0,
            adversarial_vectors: payload.adversarial_indicators.detected_vectors ?? [],
          },
        });

        // ── Adversarial Layer 8: persist per-call model audit log ────────────
        // Non-fatal — audit log failure never blocks the callback response.
        if (payload.model_call_logs.length > 0) {
          const logRows = payload.model_call_logs.map((entry) => ({
            org_id: payload.organization_id,
            document_id: payload.document_id,
            model_id: entry.model_id,
            system_prompt_hash: entry.system_prompt_hash,
            user_message_hash: entry.user_message_hash,
            output_hash: entry.output_hash,
            tokens_in: entry.tokens_in,
            tokens_out: entry.tokens_out,
            duration_ms: entry.duration_ms,
          }));
          supabaseAdmin
            .from("model_call_log")
            .insert(logRows)
            .then(({ error }) => {
              if (error) console.error("[layer8] model_call_log insert failed:", error.message);
            });
        }

        // ── Outbound webhook delivery (non-fatal) ─────────────────────────────
        deliverExtractionEvent(
          payload.organization_id,
          payload.document_id,
          payload.status,
          claimsInserted,
        ).catch((err) =>
          console.error("[callback] outbound delivery error:", err),
        );

        return new Response(
          JSON.stringify({ ok: true, claims_inserted: claimsInserted }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
