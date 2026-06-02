import { Router } from "express";

export const versionRouter = Router();

versionRouter.get("/", (_req, res) => {
  res.json({ version: "1.0.0" });
});