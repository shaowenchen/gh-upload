import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import compression from "compression";
import { config } from "./config.js";
import { cors } from "./middleware/cors.js";
import { domainValidation } from "./middleware/domainValidation.js";
import { filesRouter } from "./routes/files.js";
import { clearRouter } from "./routes/clear.js";
import { configRouter } from "./routes/configRoute.js";
import { versionRouter } from "./routes/version.js";
import { proxyRouter } from "./routes/proxy.js";
import { showError } from "./utils/response.js";

const app = express();

app.use(domainValidation);
app.use(cors);
// The page is one 31KB HTML document with its CSS and JS inline, so compressing
// it is worth a round trip or two on a slow link. The default filter decides
// per response and skips types that do not compress, so the binary chunk bodies
// on the upload path pass through untouched without needing to be excluded.
app.use(compression());

app.use("/api/v1/files", filesRouter);
app.use("/api/v1/clear", clearRouter);
app.use("/api/v1/config", configRouter);
app.use("/api/version", versionRouter);
app.use("/uploadbases", proxyRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Static assets. The HTML is the entry point and carries the client's whole
// application, so it stays on revalidate-every-time: a cached copy would pin
// browsers to an older chunk size and upload protocol than the server speaks.
// Express's ETag makes that a 304 rather than a re-download.
//
// The artwork is content-addressed by name and effectively never changes, so it
// is served as immutable — that is what spares the logo revalidation on every
// page load.
app.use(
  express.static("dist/public", {
    maxAge: 0,
    etag: true,
    setHeaders: (res, filePath) => {
      if (/\.(svg|png|ico|woff2?)$/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      }
      // upload.sh and llms.txt are read by clients that fetch them fresh each
      // time on purpose, so they stay on the default revalidate path.
    },
  })
);

/**
 * Convert framework-level failures into the JSON error shape every route uses.
 *
 * Without this, body-parser answers an oversized or malformed body with its own
 * HTML error page. A client parsing the response — an agent especially — then
 * gets an unparseable body at exactly the moment it needs to know whether to
 * retry or to split the file smaller.
 */
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = err as { type?: string; status?: number; statusCode?: number; message?: string };
  const status = e.status ?? e.statusCode ?? 500;

  if (e.type === "entity.too.large") {
    // The body was bigger than the endpoint allows. Retrying the same request
    // cannot help, so this is not marked retryable.
    showError(res, "request body too large", 413, false);
    return;
  }
  if (e.type === "entity.parse.failed") {
    showError(res, "malformed JSON body", 400, false);
    return;
  }
  if (status >= 400 && status < 500) {
    showError(res, e.message || "bad request", status, false);
    return;
  }
  console.error(err);
  showError(res, "internal server error", 500, true);
});

app.listen(config.port, config.host, () => {
  console.log(`gh-upload server listening on ${config.host}:${config.port}`);
});