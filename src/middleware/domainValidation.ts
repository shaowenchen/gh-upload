import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

export function domainValidation(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/uploadbases")) {
    next();
    return;
  }
  const requestDomain = req.hostname;
  if (requestDomain === "localhost") {
    next();
    return;
  }
  if (config.downloadUrls.length > 0 && !config.downloadUrls.includes(requestDomain)) {
    res.status(403).end();
    return;
  }
  next();
}