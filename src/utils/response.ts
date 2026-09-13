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

/**
 * Report a GitHub failure with the status it actually carried.
 *
 * The service reaches GitHub with one token, so when that token is refused or
 * rate-limited — 401, 403, 429 — the failure is the deployment's to fix, not
 * the caller's, and the distinction matters to whoever reads the error: a bare
 * 502 says "try again later", which for an unauthorised token is advice that
 * can never work. Anything that is not one of those upstream answers stays a
 * 502, and only a 5xx or a rate limit is worth retrying.
 */
export function showUpstreamError(res: Response, context: string, err: unknown): void {
  const status = (err as { status?: number }).status;
  if (status === 401 || status === 403 || status === 429) {
    showError(
      res,
      `${context}: GitHub refused the request (${status}). Check GITHUB_TOKEN's ` +
        `permissions and the API rate limit.`,
      status,
      status === 429
    );
    return;
  }
  showError(res, context, 502, status === undefined || status >= 500);
}

