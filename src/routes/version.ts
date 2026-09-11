import { Router } from "express";
import { createRequire } from "node:module";

export const versionRouter = Router();

// Read the version from package.json rather than restating it, so it cannot
// drift from the published artifact the way a literal does.
const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

versionRouter.get("/", (_req, res) => {
  res.json({ version: pkg.version });
});