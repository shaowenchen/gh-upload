import { Router } from "express";
import { showData } from "../utils/response.js";
import { config } from "../config.js";import { CHUNK_SIZE, MAX_CONCURRENT_CHUNKS } from "../utils/chunk.js";
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
    // How many chunks the server will process at once. Published so a client
    // sizes its own in-flight window to the capacity that actually exists
    // rather than guessing: asking for more than this just earns 503s.
    max_chunk_concurrency: MAX_CONCURRENT_CHUNKS,
    // A caller should know whether download links expire, so it can either
    // deliver promptly or arrange a fresh link.
    signed_links: signingEnabled(),
    link_ttl_seconds: signingEnabled() ? linkTtlSeconds() : null,
  });
});