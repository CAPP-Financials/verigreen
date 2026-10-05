"""
Outbound HMAC-signed callback to the Worker's /api/public/extraction-callback endpoint.

Signs: ${timestamp}.${json_body}  (Stripe pattern, matching the Worker's verification)
Headers:
  X-VeriGreen-Signature: sha256=<hex>
  X-VeriGreen-Timestamp: <unix seconds>
  Content-Type: application/json
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time

import httpx

from .models import ExtractionResult


def _hmac_sha256_hex(secret: str, payload: str) -> str:
    return hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()


async def send_callback(
    callback_url: str,
    webhook_secret: str,
    result: ExtractionResult,
    timeout_s: float = 30.0,
) -> None:
    """
    POST the extraction result to the Worker callback URL with HMAC signature.
    Raises httpx.HTTPError on non-2xx responses.
    """
    body = result.model_dump_json()
    timestamp = str(int(time.time()))
    signed_payload = f"{timestamp}.{body}"
    signature = _hmac_sha256_hex(webhook_secret, signed_payload)

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.post(
            callback_url,
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-VeriGreen-Signature": f"sha256={signature}",
                "X-VeriGreen-Timestamp": timestamp,
            },
        )
        response.raise_for_status()
