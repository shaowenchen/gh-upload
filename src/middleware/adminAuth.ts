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
 * Require the shared access credential for anything that writes.
 *
 * Only writes are guarded. The download URL an upload returns is the thing
 * being delivered, so it has to stay openable by whoever receives it — putting
 * the credential on reads would make every delivered link useless to its
 * recipient.
 *
 * An unset ADMIN_TOKEN fails closed rather than open. Treating "no token
 * configured" as "no protection needed" is how the previous deployment ran:
 * writes were unrestricted and the omission was invisible until someone found
 * the endpoint.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminToken) {
    showError(
      res,
      "this server has no ADMIN_TOKEN configured, so writes are disabled",
      503,
      false
    );
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
