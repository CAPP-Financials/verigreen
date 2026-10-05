import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole, getPrimaryOrgId } from "./auth.server";
import { generateToken, sha256Hex } from "./crypto.server";

const SCOPES = [
  "documents:read",
  "documents:write",
  "claims:read",
  "validations:read",
  "webhooks:configure",
  "admin:org",
] as const;

export const API_KEY_SCOPES = SCOPES;

export const listApiKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) return { keys: [] };
    await assertRole(supabase, userId, orgId, ["admin"]);
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, name, prefix, scopes, last_used_at, revoked_at, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { keys: data ?? [] };
  });

export const createApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        name: z.string().min(1).max(100),
        scopes: z.array(z.enum(SCOPES)).min(1),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const orgId = await getPrimaryOrgId(supabase, userId);
    if (!orgId) throw new Error("No organization");
    await assertRole(supabase, userId, orgId, ["admin"]);

    const secret = generateToken(32);
    const prefix = `vg_${generateToken(6).slice(0, 8)}`;
    const fullKey = `${prefix}_${secret}`;
    const keyHash = await sha256Hex(fullKey);

    const { data: row, error } = await supabase
      .from("api_keys")
      .insert({
        org_id: orgId,
        name: data.name,
        prefix,
        key_hash: keyHash,
        scopes: data.scopes,
        created_by: userId,
      })
      .select("id, name, prefix, scopes, created_at")
      .single();
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      actor_user_id: userId,
      action: "api_key_created",
      target_type: "api_key",
      target_id: row.id,
      payload: { name: row.name, scopes: data.scopes },
    });

    return { key: row, plaintext: fullKey };
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: key, error: keyErr } = await supabase
      .from("api_keys")
      .select("org_id")
      .eq("id", data.id)
      .maybeSingle();
    if (keyErr) throw new Error(keyErr.message);
    if (!key) throw new Error("Key not found");
    await assertRole(supabase, userId, key.org_id, ["admin"]);

    const { error } = await supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      org_id: key.org_id,
      actor_user_id: userId,
      action: "api_key_revoked",
      target_type: "api_key",
      target_id: data.id,
    });
    return { ok: true };
  });
