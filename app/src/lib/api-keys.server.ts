/**
 * Server-only API key verification. Used by external API gateway middleware.
 *
 * Security model:
 * - Caller presents raw Bearer token (prefix_secret format).
 * - SHA-256 hash is computed; looked up in api_keys.key_hash.
 * - Only non-revoked keys succeed.
 * - last_used_at is updated on success (non-fatal if it fails).
 * - Rate limit metadata is returned for the caller to enforce.
 *
 * Never logs the plaintext key. Hash comparison via constant-time is not
 * required here because key_hash is a DB equality lookup (no timing oracle).
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sha256Hex } from "./crypto.server";

export type VerifiedApiKey = {
  keyId: string;
  orgId: string;
  scopes: string[];
  rateLimitPerMinute: number;
};

/**
 * Verify a raw API key presented as a Bearer token.
 * Returns metadata if valid and active; null if invalid/revoked.
 */
export async function verifyApiKey(rawKey: string): Promise<VerifiedApiKey | null> {
  if (!rawKey || rawKey.length < 16) return null;

  const hash = await sha256Hex(rawKey);

  const { data, error } = await supabaseAdmin
    .from("api_keys")
    .select("id, org_id, scopes, rate_limit_per_minute, revoked_at")
    .eq("key_hash", hash)
    .maybeSingle();

  if (error || !data) return null;
  if (data.revoked_at !== null) return null;

  // Update last_used_at asynchronously — non-fatal
  void (async () => {
    try {
      await supabaseAdmin
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", data.id);
    } catch {
      /* ignore */
    }
  })();


  return {
    keyId: data.id as string,
    orgId: data.org_id as string,
    scopes: (data.scopes ?? []) as string[],
    rateLimitPerMinute: (data.rate_limit_per_minute ?? 60) as number,
  };
}

/**
 * Extract raw key from Authorization header.
 * Accepts "Bearer <key>" or bare key.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : authHeader.trim();
}
