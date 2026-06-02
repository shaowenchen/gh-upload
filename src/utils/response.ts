import type { Response } from "express";

export function showData(res: Response, data: unknown): void {
  res.json({ code: 0, data });
}

export function showError(res: Response, msg: string): void {
  res.status(200).json({ code: -1, msg });
}