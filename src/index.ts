import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
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

app.use("/api/v1/files", filesRouter);
app.use("/api/v1/clear", clearRouter);
app.use("/api/v1/config", configRouter);
app.use("/api/version", versionRouter);
app.use("/uploadbases", proxyRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(express.static("dist/public"));

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