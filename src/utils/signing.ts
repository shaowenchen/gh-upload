import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * Signed, expiring download links.
 *
 * The download URL is the deliverable — it gets pasted into tickets, handed to
 * teammates, and forwarded on. A bare URL is therefore a permanent, transferable
 * grant to read the file, which is a poor fit for anything that should not stay
 * public forever. Signing binds the URL to an expiry and to the exact path, so a
 * link stops working on its own and a signature for one file cannot be replayed
 * against another.
 *
 * Signing is off when no secret is configured, and reads stay open in that mode
 * — consistent with the rest of the service, where unset configuration means no
 * restriction rather than a locked door.
 */

/** Query parameters a signed link carries. */
export interface SignatureParams {
  expires: number;
  sig: string;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Payload binding a signature to one path and one expiry.
 *
 * The path is included so a signature cannot be lifted from a link to one file
 * and attached to another; the expiry so the window cannot be extended.
 */
function payloadFor(path: string, expiresAt: number): string {
  return `${path}\n${expiresAt}`;
}

export function signingEnabled(): boolean {
  return config.downloadSecret.length > 0;
}

export function linkTtlSeconds(): number {
  return config.downloadTtlSeconds;
}

/** Create the query string for a path, or "" when signing is disabled. */
export function signPath(path: string, now: number = Date.now()): string {
  if (!signingEnabled()) return "";
  const expires = Math.floor(now / 1000) + linkTtlSeconds();
  const sig = sign(payloadFor(path, expires), config.downloadSecret);
  return `?expires=${expires}&sig=${encodeURIComponent(sig)}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "expired" | "invalid" };

/**
 * Check the signature on a request.
 *
 * Reports why a link failed rather than a flat "forbidden": "expired" is
 * actionable (ask for a fresh link) whereas "invalid" means the URL was altered
 * or is not a link this server issued.
 */
export function verifyPath(
  path: string,
  params: Partial<SignatureParams>,
  now: number = Date.now()
): VerifyResult {
  if (!signingEnabled()) return { ok: true };

  const { expires, sig } = params;
  if (typeof expires !== "number" || !Number.isFinite(expires) || !sig) {
    return { ok: false, reason: "missing" };
  }
  if (Math.floor(now / 1000) > expires) {
    return { ok: false, reason: "expired" };
  }

  const expected = Buffer.from(sign(payloadFor(path, expires), config.downloadSecret));
  const provided = Buffer.from(sig);
  if (expected.length !== provided.length) return { ok: false, reason: "invalid" };
  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: "invalid" };
}
