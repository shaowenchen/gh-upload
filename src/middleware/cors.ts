import type { Request, Response, NextFunction } from "express";

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    // Echo the origin instead of "*": browsers reject a wildcard together with
    // credentials, so the previous combination silently disabled CORS. Safe here
    // because the only credentialed surface is the admin token, which is
    // checked independently per request.
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE, UPDATE");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Expose-Headers", "Content-Length, Access-Control-Allow-Origin, Access-Control-Allow-Headers, Cache-Control, Content-Language, Content-Type");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}