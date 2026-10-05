import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole, getPrimaryOrgId } from "./auth.server";
import { generateToken } from "./crypto.server";

export const listWebhookSecrets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) return { secrets: [] };
    await assertRole(supabase, userId, orgId, ["admin"]);
    const { data, error } = await supabase
      .from("webhook_secrets")
      .select("id, rotated_at, revoked_at, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { secrets: data ?? [] };
  });

/**
 * Issue a fresh webhook signing secret for the org. The plaintext is returned
 * exactly once. Any previously active secret is revoked.
 */
export const rotateWebhookSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) throw new Error("No organization");
    await assertRole(supabase, userId, orgId, ["admin"]);

    const now = new Date().toISOString();
    const { error: revErr } = await supabase
      .from("webhook_secrets")
      .update({ revoked_at: now })
      .eq("org_id", orgId)
      .is("revoked_at", null);
    if (revErr) throw new Error(revErr.message);

    const plaintext = `whsec_${generateToken(40)}`;

    const { data: row, error } = await supabase
      .from("webhook_secrets")
      .insert({ org_id: orgId, secret_value: plaintext, rotated_at: now })
      .select("id, created_at")
      .single();
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      actor_user_id: userId,
      action: "webhook_secret_rotated",
      target_type: "webhook_secret",
      target_id: row.id,
    });

    return { id: row.id, plaintext, created_at: row.created_at };
  });

// ─── Outbound webhook endpoint management ────────────────────────────────────

export const listWebhookEndpoints = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) return { endpoints: [] };
    await assertRole(supabase, userId, orgId, ["admin"]);
    const { data, error } = await supabase
      .from("webhook_endpoints")
      .select("id, url, events, enabled, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { endpoints: data ?? [] };
  });

/**
 * Reject URLs targeting internal/private infrastructure to prevent SSRF.
 * Blocks: non-https, loopback, link-local (incl. cloud metadata 169.254.169.254),
 * RFC-1918 private ranges, and IPv6 loopback/ULA.
 */
function assertSafeWebhookUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Invalid URL"); }
  if (u.protocol !== "https:") throw new Error("Webhook URL must use https://");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") {
    throw new Error("Webhook URL targets a disallowed host");
  }
  // IPv4 literal check
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224; // multicast / reserved
    if (isPrivate) throw new Error("Webhook URL targets a disallowed host");
  }
  // IPv6 literal check (block ULA fc00::/7 and link-local fe80::/10)
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) {
      throw new Error("Webhook URL targets a disallowed host");
    }
  }
}

export const createWebhookEndpoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z.object({
      url: z.string().url().max(2048),
      events: z.array(z.enum(["extraction.completed", "extraction.failed"])).min(1).default(["extraction.completed", "extraction.failed"]),
    }).parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) throw new Error("No organization");
    await assertRole(supabase, userId, orgId, ["admin"]);
    assertSafeWebhookUrl(data.url);

    const signingSecret = `whsec_${generateToken(40)}`;

    const { data: row, error } = await supabase
      .from("webhook_endpoints")
      .insert({
        org_id: orgId,
        url: data.url,
        signing_secret: signingSecret,
        events: data.events,
        enabled: true,
      })
      .select("id, url, events, created_at")
      .single();
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      actor_user_id: userId,
      action: "webhook_endpoint_created",
      target_type: "webhook_endpoint",
      target_id: row.id,
      payload: { url: data.url, events: data.events },
    });

    // Return signing secret once — caller must save it; it will not be shown again
    return { endpoint: row, signing_secret: signingSecret };
  });

export const deleteWebhookEndpoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: ep, error: epErr } = await supabase
      .from("webhook_endpoints")
      .select("org_id")
      .eq("id", data.id)
      .maybeSingle();
    if (epErr) throw new Error(epErr.message);
    if (!ep) throw new Error("Endpoint not found");
    await assertRole(supabase, userId, ep.org_id, ["admin"]);

    const { error } = await supabase
      .from("webhook_endpoints")
      .update({ enabled: false })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      org_id: ep.org_id,
      actor_user_id: userId,
      action: "webhook_endpoint_disabled",
      target_type: "webhook_endpoint",
      target_id: data.id,
    });
    return { ok: true };
  });
