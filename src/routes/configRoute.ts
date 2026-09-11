import { Router } from "express";
import { showData } from "../utils/response.js";
import { config } from "../config.js";
import { CHUNK_SIZE } from "../utils/chunk.js";
import { MAX_SIMPLE_UPLOAD } from "../utils/limits.js";
import { signingEnabled, linkTtlSeconds } from "../utils/signing.js";

export const configRouter = Router();

configRouter.get("/", (req, res) => {
  const proto = (req.headers["x-forwarded-proto"] as string) ||
    (req.socket && "encrypted" in req.socket ? "https" : "http");
  const host = req.headers.host || "localhost";

  let apiBaseURL: string;
  if (config.downloadUrls.length > 0) {
    apiBaseURL = `https://${config.downloadUrls[0]}`;
  } else {
    apiBaseURL = `${proto}://${host}`;
  }

  showData(res, {
    api_base_url: apiBaseURL,
    upload_url: `${apiBaseURL}/api/v1/files`,
    // Published so the browser slices at exactly the size the server and the
    // CDN edge accept, instead of hardcoding a copy that can drift.
    chunk_size: CHUNK_SIZE,
    // A client needs this to pick between the single-request and chunked paths;
    // sending something larger than it to POST /api/v1/files is rejected.
    max_simple_upload: MAX_SIMPLE_UPLOAD,
    // A client should ask rather than assume: an operator may run this with the
    // token unset, in which case writes need no credential.
    auth_required: Boolean(config.adminToken),
    // A caller should know whether download links expire, so it can either
    // deliver promptly or arrange a fresh link.
    signed_links: signingEnabled(),
    link_ttl_seconds: signingEnabled() ? linkTtlSeconds() : null,
  });
});