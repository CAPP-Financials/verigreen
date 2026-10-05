/**
 * Postgres-backed sliding 1-minute rate limiter for API keys.
 *
 * Uses an INSERT ... ON CONFLICT DO UPDATE atomic counter per (api_key_id, window_minute).
 * The window_minute is truncated to the current UTC minute; each new minute gets a
 * fresh counter automatically.
 *
 * Cleanup: old counter rows accumulate — prune nightly via:
 *   DELETE FROM rate_limit_counters WHERE window_start < now() - interval '2 minutes';
 * (A pg_cron job or Supabase cron edge function handles this post-launch.)
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
};

/**
 * Increment the request counter for the given API key in the current minute window.
 * Returns whether the request is allowed and how many requests remain.
 */
export async function checkRateLimit(
  keyId: string,
  limitPerMinute: number,
): Promise<RateLimitResult> {
  // Truncate to the current UTC minute
  const now = new Date();
  const windowStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    0,
    0,
  ).toISOString();

  try {
    // Atomic upsert: insert row with count=1; on conflict increment and return new count
    const { data, error } = await supabaseAdmin.rpc("increment_rate_limit", {
      p_api_key_id: keyId,
      p_window_start: windowStart,
    });

    if (error) {
      // On DB error: fail open (allow the request) to avoid blocking legitimate traffic
      console.error("[rate_limit] DB error, failing open:", error.message);
      return { allowed: true, remaining: limitPerMinute - 1, limit: limitPerMinute };
    }

    const count = (data as number) ?? 1;
    const allowed = count <= limitPerMinute;
    return {
      allowed,
      remaining: Math.max(0, limitPerMinute - count),
      limit: limitPerMinute,
    };
  } catch (err) {
    console.error("[rate_limit] Unexpected error, failing open:", err);
    return { allowed: true, remaining: limitPerMinute - 1, limit: limitPerMinute };
  }
}
