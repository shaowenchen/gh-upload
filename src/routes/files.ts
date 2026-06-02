import { Router } from "express";
import type { Request } from "express";
import multer from "multer";
import os from "node:os";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { GitHubService } from "../services/github.js";
import { showData, showError } from "../utils/response.js";
import { config } from "../config.js";
import {
  CHUNK_SIZE,
  saveLargeFile,
  reassembleFile,
  sanitizeFilename,
  splitTime,
  isChunkPartName,
  isManifestName,
  manifestName,
  type ChunkManifest,
} from "../utils/chunk.js";

const upload = multer({ dest: os.tmpdir() });

export const filesRouter = Router();

// POST /api/v1/files - Upload a file
filesRouter.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).send("get form err: no file");
    return;
  }

  const github = new GitHubService();
  const originalName = sanitizeFilename(file.originalname);
  const contentType = file.mimetype || "application/octet-stream";

  try {
    let downloadUrl: string;
    if (file.size > CHUNK_SIZE) {
      const manifest = await saveLargeFile(github, file.path, originalName, contentType, file.size);
      downloadUrl = buildPublicURL(req, `/api/v1/files/${manifest.file_id}/download`);
    } else {
      const repoPath = `${Math.floor(Date.now() / 1000)}-${originalName}`;
      const rawPath = await github.uploadContent(repoPath, readFileSync(file.path));
      downloadUrl = rawPath ? buildConfiguredRawURL(rawPath) : "";
    }

    if (!downloadUrl) {
      showError(res, "upload file err");
      return;
    }
    showData(res, { download_url: downloadUrl });
  } catch (err) {
    console.error(err);
    showError(res, "upload file err");
  } finally {
    unlink(file.path).catch(() => {});
  }
});

// GET /api/v1/files - List files
filesRouter.get("/", async (req, res) => {
  const github = new GitHubService();
  try {
    const repo = await github.getOrCreateRepo();
    const contents = await github.listFiles(repo);

    const result: Array<{
      size?: number;
      name?: string;
      timestamp: number;
      download_url: string;
    }> = [];

    for (const file of contents) {
      if (!file.name) continue;

      if (isChunkPartName(file.name)) continue;

      if (isManifestName(file.name)) {
        try {
          const manifestBytes = await github.downloadFile(repo, file.name);
          const manifest: ChunkManifest = JSON.parse(manifestBytes.toString("utf-8"));
          result.push({
            size: manifest.size,
            name: manifest.original_name,
            timestamp: manifest.created_at,
            download_url: buildPublicURL(req, `/api/v1/files/${manifest.file_id}/download`),
          });
        } catch (err) {
          console.error(err);
        }
        continue;
      }

      const [timeStamp, filename] = splitTime(file.name);
      result.push({
        size: file.size,
        name: filename,
        timestamp: timeStamp,
        download_url: buildRawDownloadURL(file.download_url || null),
      });
    }

    result.sort((a, b) => b.timestamp - a.timestamp);
    showData(res, { list: result });
  } catch (err) {
    console.error(err);
    showError(res, "list files err");
  }
});

// GET /api/v1/files/:id/download - Download a chunked file
filesRouter.get("/:id/download", async (req, res) => {
  const fileId = req.params.id;
  if (!fileId || fileId.includes("/") || fileId.includes("..")) {
    res.status(400).send("invalid file id");
    return;
  }

  const github = new GitHubService();
  try {
    const repo = await github.getOrCreateRepo();
    const manifestBytes = await github.downloadFile(repo, manifestName(fileId));
    const manifest: ChunkManifest = JSON.parse(manifestBytes.toString("utf-8"));

    const assembled = await reassembleFile(github, repo, manifest);

    res.setHeader("Content-Type", manifest.content_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${manifest.original_name}"`);
    res.setHeader("Content-Length", assembled.length);
    res.end(assembled);
  } catch (err) {
    console.error(err);
    res.status(404).send("file not found");
  }
});

function buildPublicURL(req: Request, urlPath: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string) ||
    (req.socket && "encrypted" in req.socket ? "https" : "http");
  return `${proto}://${req.headers.host}${urlPath}`;
}

function buildRawDownloadURL(downloadUrl: string | null): string {
  if (!downloadUrl) return "";
  if (downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://")) {
    return buildConfiguredRawURL(downloadUrl);
  }
  return buildConfiguredRawURL(`https://raw.githubusercontent.com/${downloadUrl}`);
}

function buildConfiguredRawURL(downloadUrl: string): string {
  if (config.downloadUrls.length === 0) {
    if (downloadUrl.startsWith("http")) return downloadUrl;
    return `https://raw.githubusercontent.com/${downloadUrl}`;
  }
  return downloadUrl.replace("raw.githubusercontent.com", config.downloadUrls[0]);
}