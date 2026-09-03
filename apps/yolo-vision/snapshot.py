"""
Snapshot fetcher — pulls a JPEG/PNG byte string from a URL.

Supports:
  • Plain HTTP/HTTPS GET (no auth).
  • HTTP Basic auth (httpx native).
  • HTTP Digest auth (httpx native) — needed for Hikvision ISAPI which
    rejects Basic on modern firmware.

The detector itself does NOT need network access in production — Edge
fetches the snapshot LAN-side (it already does digest auth for LPR) and
passes it as base64 in the /detect body. This module exists as a smoke
test convenience (`POST /detect {image_url: ...}`) and for development.
"""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)


async def fetch_image(
    url: str,
    login: str | None = None,
    password: str | None = None,
    timeout_s: int = 8,
    verify_ssl: bool = False,
) -> bytes:
    """
    Fetch URL and return image bytes. Tries auth in order: digest → basic →
    no-auth. `verify_ssl=False` because Hikvision cameras ship self-signed
    certs and we're always on LAN.
    """
    transport = httpx.AsyncHTTPTransport(verify=verify_ssl, retries=1)
    timeout = httpx.Timeout(timeout_s, connect=4)

    auth_chain: list[httpx.Auth | None] = []
    if login and password:
        # Hikvision wants Digest. Try it first.
        auth_chain.append(httpx.DigestAuth(login, password))
        auth_chain.append(httpx.BasicAuth(login, password))
    auth_chain.append(None)

    errors: list[str] = []
    # User-Agent header — Wikipedia/CDN-y zwracają 403 bez UA (anty-bot).
    # Hikvision i większość camera HTTP serwerów ignoruje UA, ale nie szkodzi.
    headers = {"User-Agent": "gatelynk-vision/1.0 (object detection)"}

    async with httpx.AsyncClient(
        transport=transport, timeout=timeout, follow_redirects=True,
        headers=headers,
    ) as client:
        for auth in auth_chain:
            try:
                r = await client.get(url, auth=auth)
                if r.status_code == 200:
                    ctype = r.headers.get("content-type", "").lower()
                    body = r.content
                    if len(body) < 500:
                        errors.append(
                            f"auth={_auth_name(auth)} → tiny payload {len(body)}B"
                        )
                        continue
                    if not ctype.startswith("image/"):
                        # Some cameras return application/octet-stream for JPEG.
                        # Trust the magic bytes instead of content-type alone.
                        if not (len(body) >= 3 and body[:3] == b"\xff\xd8\xff"):
                            errors.append(
                                f"auth={_auth_name(auth)} → content-type={ctype} not image"
                            )
                            continue
                    return body
                errors.append(f"auth={_auth_name(auth)} → HTTP {r.status_code}")
            except httpx.HTTPError as e:
                errors.append(f"auth={_auth_name(auth)} → {type(e).__name__}: {e}")

    raise RuntimeError(f"Snapshot fetch failed for {url}: {' | '.join(errors)}")


def _auth_name(a: httpx.Auth | None) -> str:
    if a is None:
        return "none"
    if isinstance(a, httpx.DigestAuth):
        return "digest"
    if isinstance(a, httpx.BasicAuth):
        return "basic"
    return type(a).__name__
