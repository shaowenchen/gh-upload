import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminToken) {
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== config.adminToken) {
    res.status(403).json({ code: 403, message: "Forbidden: admin access required" });
    return;
  }

  next();
}