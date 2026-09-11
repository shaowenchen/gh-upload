import type { Response } from "express";

export function showData(res: Response, data: unknown): void {
  res.json({ code: 0, data });
}

/**
 * Send an error with a real HTTP status code.
 *
 * Errors used to go out as HTTP 200 with `code: -1`. Clients that branch on the
 * status line — `curl -f`, `res.ok`, most agent HTTP layers — read that as
 * success and carry on with a body they cannot use. The status code is the part
 * every client can act on, so it has to be right; the `code` field stays for
 * existing callers.
 */
export function showError(
  res: Response,
  msg: string,
  status = 400,
  retryable = false
): void {
  res.status(status).json({ code: -1, msg, retryable });
}
