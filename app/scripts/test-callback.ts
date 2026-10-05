/**
 * Smoke test for /api/public/extraction-callback HMAC verification.
 *
 * Usage:
 *   bun run scripts/test-callback.ts <BASE_URL> <ORG_ID> <SECRET_PLAINTEXT>
 *
 * Pass the plaintext secret exactly as shown once in the UI at rotation —
 * no transformation required. The signature is HMAC-SHA256 over
 * `${timestamp}.${rawBody}` (Stripe-style); the timestamp is sent in the
 * `x-verigreen-timestamp` header (Unix seconds, UTC).
 */

async function hmacSha256Hex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const [, , baseUrl, orgId, secretPlaintext] = process.argv;
if (!baseUrl || !orgId || !secretPlaintext) {
  console.error("Usage: bun scripts/test-callback.ts <BASE_URL> <ORG_ID> <SECRET_PLAINTEXT>");
  process.exit(2);
}

const body = JSON.stringify({
  job_id: crypto.randomUUID(),
  document_id: crypto.randomUUID(),
  organization_id: orgId,
  status: "complete",
  claims: [],
  validations: [],
  error: null,
  metrics: { tokens_used: 0, duration_ms: 0, model_calls: 0 },
});

const url = `${baseUrl.replace(/\/$/, "")}/api/public/extraction-callback`;

// Test 1: valid signed request with current timestamp → 200
const timestamp = Math.floor(Date.now() / 1000);
const sig = await hmacSha256Hex(secretPlaintext, `${timestamp}.${body}`);

const ok = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-verigreen-signature": `sha256=${sig}`,
    "x-verigreen-timestamp": `${timestamp}`,
  },
  body,
});
console.log("valid request →", ok.status, await ok.text());
if (ok.status !== 200) process.exitCode = 1;

// Test 2: tampered signature → 401
const tampered = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-verigreen-signature": `sha256=${"0".repeat(64)}`,
    "x-verigreen-timestamp": `${timestamp}`,
  },
  body,
});
console.log("tampered request →", tampered.status, await tampered.text());
if (tampered.status !== 401) process.exitCode = 1;

// Test 3: replay with stale timestamp (10 minutes old) → 401 "Stale request"
const staleTs = timestamp - 600;
const staleSig = await hmacSha256Hex(secretPlaintext, `${staleTs}.${body}`);
const stale = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-verigreen-signature": `sha256=${staleSig}`,
    "x-verigreen-timestamp": `${staleTs}`,
  },
  body,
});
const staleText = await stale.text();
console.log("stale (replayed) request →", stale.status, staleText);
if (stale.status !== 401 || !staleText.includes("Stale")) process.exitCode = 1;
