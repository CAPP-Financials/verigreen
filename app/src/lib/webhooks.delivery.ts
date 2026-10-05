/**
 * Outbound webhook delivery — Worker → customer.
 *
 * Fetches all enabled endpoints for the org, signs the payload with HMAC-SHA256
 * (same Stripe pattern as inbound), and delivers with 3 attempts + exponential
 * backoff (1 s → 2 s → 4 s). Failed deliveries are written to webhook_deliveries
 * as a dead-letter queue for later retry or manual inspection.
 *
 * Signature:
 *   X-VeriGreen-Signature:  sha256=<hex>
 *   X-VeriGreen-Timestamp:  <unix seconds>
 *   Signed payload:         `${timestamp}.${JSON.stringify(body)}`
 *
 * Delivery is always non-fatal to the caller — errors are logged and persisted.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hmacSha256Hex } from "./crypto.server";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

export type WebhookEvent = {
  event: string;            // e.g. "extraction.completed"
  document_id: string;
  org_id: string;
  status: string;
  claims_count?: number;
  timestamp: string;        // ISO 8601
};

/** Deliver an event to all active endpoints registered for the org. */
export async function deliverExtractionEvent(
  orgId: string,
  documentId: string,
  status: "complete" | "partial" | "failed",
  claimsCount: number,
): Promise<void> {
  const eventType = status === "failed" ? "extraction.failed" : "extraction.completed";

  const { data: endpoints, error } = await supabaseAdmin
    .from("webhook_endpoints")
    .select("id, url, signing_secret, events")
    .eq("org_id", orgId)
    .eq("enabled", true);

  if (error || !endpoints?.length) return;

  const body: WebhookEvent = {
    event: eventType,
    document_id: documentId,
    org_id: orgId,
    status,
    claims_count: claimsCount,
    timestamp: new Date().toISOString(),
  };
  const bodyStr = JSON.stringify(body);

  for (const endpoint of endpoints) {
    // Skip endpoints not subscribed to this event
    if (!endpoint.events?.includes(eventType)) continue;

    await _deliverToEndpoint(endpoint.id, orgId, endpoint.url, endpoint.signing_secret, eventType, bodyStr);
  }
}

async function _deliverToEndpoint(
  endpointId: string,
  orgId: string,
  url: string,
  signingSecret: string,
  eventType: string,
  bodyStr: string,
): Promise<void> {
  // SSRF guard: refuse to dispatch to non-https or private/internal hosts,
  // even if a legacy row slipped past the create-time validator.
  if (!_isSafeWebhookUrl(url)) {
    try {
      await supabaseAdmin.from("webhook_deliveries").insert({
        endpoint_id: endpointId,
        org_id: orgId,
        event_type: eventType,
        payload: JSON.parse(bodyStr),
        attempt_count: 0,
        last_attempt_at: new Date().toISOString(),
        last_status_code: null,
        last_error: "Blocked: disallowed webhook URL (SSRF guard)",
        delivered_at: null,
      });
    } catch (e) {
      console.error("[webhook_delivery] guard DLQ write failed:", e);
    }
    return;
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${bodyStr}`;
  const sig = await hmacSha256Hex(signingSecret, signedPayload);

  let lastError: string | null = null;
  let lastStatusCode: number | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    attempts++;
    if (attempt > 0) {
      await _sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VeriGreen-Signature": `sha256=${sig}`,
          "X-VeriGreen-Timestamp": String(timestamp),
          "User-Agent": "VeriGreen-Webhook/1.0",
        },
        body: bodyStr,
        signal: AbortSignal.timeout(10_000), // 10 s per attempt
      });

      lastStatusCode = res.status;

      if (res.ok) {
        // Success — log delivery and return
        await supabaseAdmin.from("webhook_deliveries").insert({
          endpoint_id: endpointId,
          org_id: orgId,
          event_type: eventType,
          payload: JSON.parse(bodyStr),
          attempt_count: attempts,
          last_attempt_at: new Date().toISOString(),
          last_status_code: res.status,
          delivered_at: new Date().toISOString(),
        });
        return;
      }

      // Non-2xx: treat as transient failure, retry
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatusCode = null;
    }
  }

  // All attempts failed — write to DLQ
  try {
    await supabaseAdmin.from("webhook_deliveries").insert({
      endpoint_id: endpointId,
      org_id: orgId,
      event_type: eventType,
      payload: JSON.parse(bodyStr),
      attempt_count: attempts,
      last_attempt_at: new Date().toISOString(),
      last_status_code: lastStatusCode,
      last_error: lastError,
      delivered_at: null,
    });
  } catch (dlqErr) {
    // DLQ write also failed — last resort log
    console.error("[webhook_delivery] DLQ write failed:", dlqErr, "for endpoint", endpointId);
  }
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _isSafeWebhookUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) return false;
  }
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") ||
        v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return false;
  }
  return true;
}
