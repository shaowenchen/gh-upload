import { Router } from "express";
import { showData } from "../utils/response.js";
import { config } from "../config.js";

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
  });
});