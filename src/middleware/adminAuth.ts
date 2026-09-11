import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { showError } from "../utils/response.js";

/** Compare without leaking the match position through response timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  // timingSafeEqual throws on a length mismatch, and length is not secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the credential from the standard Authorization header. */
function presentedToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

/**
 * Gate on the shared access token.
 *
 * The token is a global switch: when ADMIN_TOKEN is set, every gated request
 * must present it; when it is unset, the gate is off and requests pass through.
 * So an operator who wants no restriction simply leaves it unset.
 *
 * Only writes are gated. The download URL an upload returns is the thing being
 * delivered, so it has to stay openable by whoever receives it — gating reads
 * would make every delivered link useless to its recipient.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminToken) {
    next();
    return;
  }

  const token = presentedToken(req);
  if (!token || !tokensMatch(token, config.adminToken)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="gh-upload"');
    showError(res, "missing or invalid access token", 401, false);
    return;
  }

  next();
}
