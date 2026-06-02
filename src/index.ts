import "dotenv/config";
import express from "express";
import { config } from "./config.js";
import { cors } from "./middleware/cors.js";
import { domainValidation } from "./middleware/domainValidation.js";
import { filesRouter } from "./routes/files.js";
import { clearRouter } from "./routes/clear.js";
import { configRouter } from "./routes/configRoute.js";
import { versionRouter } from "./routes/version.js";
import { proxyRouter } from "./routes/proxy.js";

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

app.listen(config.port, config.host, () => {
  console.log(`gh-upload server listening on ${config.host}:${config.port}`);
});