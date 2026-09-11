import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import multer from "multer";
import os from "node:os";
import { unlink, readFile } from "node:fs/promises";
import { GitHubService } from "../services/github.js";
import { showData, showError } from "../utils/response.js";
import { config } from "../config.js";
import {
  CHUNK_SIZE,
  sha256Hex,
  fileIdFromContentHash,
  isValidUploadId,
  sanitizeFilename,
  splitTime,
  isGeneratedName,
  manifestName,
  partName,
  simpleStoragePath,
  HASH_ALGORITHM,
  MAX_CONCURRENT_CHUNKS,
  MAX_QUEUED_CHUNKS,
  type ChunkManifest,
} from "../utils/chunk.js";

const upload = multer({ dest: os.tmpdir() });

/**
 * Largest file the single-request path accepts. Anything larger has to use the
 * chunked endpoints, because a bigger body is rejected at Cloudflare's edge
 * (413) before it reaches this process.
 */
const MAX_SIMPLE_UPLOAD = CHUNK_SIZE;

/** Manifests fetched concurrently while building the file list. */
const LIST_CONCURRENCY = 8;

/**
 * Chunk requests admitted at once. Writing a chunk to GitHub peaks at roughly
 * 7x its size in transient heap (base64 + JSON copies), so this bound is what
 * keeps process memory independent of how many clients upload at the same time
 * or how aggressively they parallelise.
 */
const chunkGate = createGate(MAX_CONCURRENT_CHUNKS, MAX_QUEUED_CHUNKS);

export const filesRouter = Router();

/**
 * Admit a chunk request only when there is room to hold and encode its body.
 *
 * This runs before express.raw, because body buffering is itself the expensive
 * part — gating afterwards would bound only the encoding step while every
 * concurrent request had already claimed a full chunk of memory. Shedding load
 * here keeps process memory a function of the configured limits rather than of
 * how many clients happen to be uploading at once.
 */
async function admitChunk(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const release = await chunkGate.acquire();
  if (!release) {
    // 503 + retryable tells the client to back off and resend this chunk, which
    // is safe: chunks are content-addressed and carry no session state.
    //
    // Drain the refused body before replying. Answering while the client is
    // still writing would end the response with unread data in flight, which
    // Node resolves by destroying the socket — the client then sees a
    // connection reset rather than this status, and a reset reads as a network
    // failure instead of an instruction to retry.
    req.resume();
    res.setHeader("Retry-After", "1");
    showError(res, "server busy, retry this chunk shortly", 503, true);
    return;
  }
  // Release when the response finishes or the client goes away mid-upload.
  res.on("close", release);
  next();
}

// POST /api/v1/files/chunks - Upload one chunk of a large file
//
// Uses a raw octet-stream body rather than multipart so the body is exactly the
// chunk, making the limit below map 1:1 onto what Cloudflare measures.
filesRouter.post(
  "/chunks",
  admitChunk,
  express.raw({ type: "*/*", limit: CHUNK_SIZE + 1024 }),
  async (req, res) => {
    // A client-chosen session id. The file's real id is derived from content
    // at completion, so this only has to be well-formed; retrying a chunk
    // reuses the same id, and re-sending identical content resolves to the
    // same git blob regardless.
    const uploadId = String(req.query.upload_id ?? "");
    const index = Number(req.query.index);
    const total = Number(req.query.total);

    if (!isValidUploadId(uploadId)) {
      showError(res, "invalid upload_id", 400);
      return;
    }
    if (!Number.isInteger(index) || !Number.isInteger(total)) {
      showError(res, "index and total must be integers", 400);
      return;
    }
    if (index < 1 || total < 1 || index > total) {
      showError(res, "index must be within 1..total", 400);
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length === 0) {
      showError(res, "empty chunk body", 400);
      return;
    }
    if (body.length > CHUNK_SIZE) {
      showError(res, `chunk exceeds ${CHUNK_SIZE} bytes`, 413);
      return;
    }
    // Every chunk before the last must be full, so any short chunk in the
    // middle means the client split the file inconsistently.
    const isLast = index === total;
    if (!isLast && body.length !== CHUNK_SIZE) {
      showError(
        res,
        `chunk ${index} of ${total} is ${body.length} bytes; non-final chunks must be exactly ${CHUNK_SIZE}`,
        400
      );
      return;
    }

    try {
      const github = new GitHubService();
      const blobSha = await github.createBlob(body);
      showData(res, {
        upload_id: uploadId,
        index,
        size: body.length,
        sha256: sha256Hex(body),
        blob_sha: blobSha,
      });
    } catch (err) {
      console.error(err);
      showError(res, "upload chunk failed", 502, true);
    }
  }
);

// POST /api/v1/files/complete - Finalize a chunked upload atomically
//
// The chunks themselves are the storage; a git blob cannot be concatenated, so
// there is no assembled file object. This commits the chunk blobs (unreferenced
// until now, hence invisible in the repo) together with the manifest that
// describes their order, in a single commit.
filesRouter.post("/complete", express.json({ limit: "1mb" }), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const originalName =
    typeof body.original_name === "string" ? sanitizeFilename(body.original_name) : "";
  const size = Number(body.size);
  const totalChunks = Number(body.total_chunks);
  const contentHash = String(body.content_hash ?? "");
  const rawChunks = Array.isArray(body.chunks) ? body.chunks : [];

  if (!originalName) {
    showError(res, "original_name is required", 400);
    return;
  }
  if (!Number.isInteger(size) || size <= 0) {
    showError(res, "size must be a positive integer", 400);
    return;
  }
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || rawChunks.length !== totalChunks) {
    showError(res, "chunks must cover every index of total_chunks", 400);
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    showError(res, "content_hash must be a 64-character hex digest", 400);
    return;
  }

  // Clients send only the ordered digests; per-chunk sizes are deterministic
  // from the total, so there is no reason to make callers restate them (and a
  // caller that gets them wrong produces a corrupt file).
  const chunks = rawChunks.map((entry, i) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    return {
      index: i + 1,
      sha256: String(c.sha256 ?? ""),
      blob_sha: String(c.blob_sha ?? ""),
    };
  });

  const shasOk = chunks.every((c) => /^[a-f0-9]{40}$/.test(c.blob_sha));
  if (!shasOk) {
    showError(res, "every chunk needs the blob_sha returned by /chunks", 400);
    return;
  }

  // Everything but the final chunk is exactly CHUNK_SIZE; the last one holds
  // the remainder. Reject splits that would not reconstruct the stated size.
  const expectedSizes = (): number[] => {
    const sizes = new Array<number>(totalChunks).fill(CHUNK_SIZE);
    sizes[totalChunks - 1] = size - (totalChunks - 1) * CHUNK_SIZE;
    return sizes;
  };
  const sizes = expectedSizes();
  const lastSize = sizes[totalChunks - 1];
  if (lastSize <= 0 || lastSize > CHUNK_SIZE) {
    showError(
      res,
      `size ${size} is inconsistent with ${totalChunks} chunks of ${CHUNK_SIZE} bytes`,
      400
    );
    return;
  }

  const fileId = fileIdFromContentHash(contentHash);
  const manifest: ChunkManifest = {
    version: 2,
    file_id: fileId,
    original_name: originalName,
    content_type: String(body.content_type ?? "application/octet-stream"),
    size,
    chunk_size: CHUNK_SIZE,
    total_chunks: totalChunks,
    content_hash: contentHash,
    hash_algorithm: HASH_ALGORITHM,
    chunks: chunks.map((c) => ({
      index: c.index,
      // Recomputed rather than trusting the client's spelling of the name.
      name: partName(fileId, c.index, totalChunks),
      size: sizes[c.index - 1],
      sha256: c.sha256,
      blob_sha: c.blob_sha,
    })),
    created_at: Math.floor(Date.now() / 1000),
  };

  try {
    const github = new GitHubService();
    const manifestBlob = await github.createBlob(
      Buffer.from(JSON.stringify(manifest, null, 2), "utf-8")
    );

    // All chunk blobs land in the same commit as the manifest, so an upload is
    // either fully visible or not visible at all — no half-finished file, and
    // no stray objects if the client dies mid-way (unreferenced blobs are
    // garbage-collected by GitHub).
    await github.commitFiles(
      [
        ...manifest.chunks.map((c) => ({ path: c.name, sha: c.blob_sha })),
        { path: manifestName(fileId), sha: manifestBlob },
      ],
      `Upload ${originalName} (${totalChunks} chunks)`
    );

    showData(res, {
      file_id: fileId,
      name: originalName,
      size,
      content_hash: contentHash,
      download_url: buildPublicURL(req, `/api/v1/files/${fileId}/download`),
    });
  } catch (err) {
    console.error(err);
    showError(res, "finalize upload failed", 502);
  }
});

// POST /api/v1/files - Upload a whole file in one request
filesRouter.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    showError(res, "get form err: no file", 400);
    return;
  }

  const originalName = sanitizeFilename(file.originalname);

  try {
    if (file.size > MAX_SIMPLE_UPLOAD) {
      // Answer with JSON rather than letting the edge return its HTML page.
      showError(
        res,
        `file is ${file.size} bytes but single-request uploads are limited to ${MAX_SIMPLE_UPLOAD}. Use the chunked upload endpoints.`,
        413
      );
      return;
    }

    const github = new GitHubService();
    const content = await readFile(file.path);
    const repoPath = simpleStoragePath(originalName, Date.now());
    const blobSha = await github.createBlob(content);
    await github.commitFiles([{ path: repoPath, sha: blobSha }], `Upload ${originalName}`);

    showData(res, {
      name: originalName,
      size: file.size,
      // Minor difference from the chunked path, which hashes chunk digests
      // rather than file bytes: for a single-chunk file these coincide.
      content_hash: sha256Hex(content),
      content_type: file.mimetype || "application/octet-stream",
      download_url: buildRawURL(repoPath),
    });
  } catch (err) {
    console.error(err);
    showError(res, "upload file err", 502);
  } finally {
    unlink(file.path).catch(() => {});
  }
});

// GET /api/v1/files - List files
filesRouter.get("/", async (req, res) => {
  const github = new GitHubService();
  try {
    const repo = await github.getOrCreateRepo();
    const treeSha = await github.getBranchTreeSha(repo);
    if (!treeSha) {
      showData(res, { list: [] });
      return;
    }

    const entries = await github.getTreeEntries(treeSha);

    const result: Array<{
      size?: number;
      name?: string;
      content_hash?: string;
      timestamp: number;
      download_url: string;
    }> = [];

    const manifests: string[] = [];
    for (const [path, entry] of entries) {
      if (isGeneratedName(path)) {
        if (path.endsWith(".manifest.json")) manifests.push(path);
        continue;
      }
      const [timeStamp, filename] = splitTime(path);
      result.push({
        size: entry.size,
        name: filename,
        timestamp: timeStamp,
        download_url: buildRawURL(path),
      });
    }

    // The tree listing already gives every plain file's size, so only manifests
    // need a body read — and those fetch concurrently.
    const loaded = await mapWithConcurrency(manifests, LIST_CONCURRENCY, async (path) => {
      try {
        const entry = entries.get(path);
        if (!entry) return null;
        const bytes = await github.getBlob(entry.sha);
        return JSON.parse(bytes.toString("utf-8")) as ChunkManifest;
      } catch (err) {
        console.error(err);
        return null;
      }
    });

    for (const manifest of loaded) {
      if (!manifest) continue;
      result.push({
        size: manifest.size,
        name: manifest.original_name,
        content_hash: manifest.content_hash,
        timestamp: manifest.created_at,
        download_url: buildPublicURL(req, `/api/v1/files/${manifest.file_id}/download`),
      });
    }

    result.sort((a, b) => b.timestamp - a.timestamp);
    showData(res, { list: result });
  } catch (err) {
    console.error(err);
    showError(res, "list files err", 502);
  }
});

// GET /api/v1/files/:id - Metadata for a chunked upload
filesRouter.get("/:id", async (req, res) => {
  const fileId = req.params.id;
  if (!isValidUploadId(fileId)) {
    showError(res, "invalid file id", 400);
    return;
  }

  const github = new GitHubService();
  try {
    const manifest = await loadManifest(github, fileId);
    showData(res, {
      file_id: manifest.file_id,
      name: manifest.original_name,
      size: manifest.size,
      content_hash: manifest.content_hash,
      hash_algorithm: manifest.hash_algorithm,
      content_type: manifest.content_type,
      created_at: manifest.created_at,
      total_chunks: manifest.total_chunks,
      download_url: buildPublicURL(req, `/api/v1/files/${fileId}/download`),
    });
  } catch {
    showError(res, "file not found", 404);
  }
});

// GET /api/v1/files/:id/download - Stream a chunked file back to the client
filesRouter.get("/:id/download", async (req, res) => {
  const fileId = req.params.id;
  if (!isValidUploadId(fileId)) {
    showError(res, "invalid file id", 400);
    return;
  }

  const github = new GitHubService();
  try {
    const manifest = await loadManifest(github, fileId);

    res.setHeader("Content-Type", manifest.content_type || "application/octet-stream");
    // Non-ASCII names need both forms: a quoted fallback for simple clients and
    // the RFC 5987 filename* for anything that understands it. Percent-encoding
    // inside a plain filename= would be taken literally.
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFallback(manifest.original_name)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(manifest.original_name)}`
    );
    // The manifest knows the total size, so this stays a plain response rather
    // than chunked transfer encoding.
    res.setHeader("Content-Length", manifest.size);

    // Write one chunk at a time. The old code concatenated the whole file into
    // a single buffer, which for a large file sits right on the pod's memory
    // limit and fails the download.
    for (const part of manifest.chunks) {
      const chunk = await github.getBlob(part.blob_sha);
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      showError(res, "file not found", 404);
    } else {
      // Headers are already out; a truncated body is the only signal left.
      res.destroy();
    }
  }
});

/** Strip anything outside ASCII so it can live in a quoted header parameter. */
function asciiFallback(name: string): string {
  const cleaned = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return cleaned || "download";
}

async function loadManifest(
  github: GitHubService,
  fileId: string
): Promise<ChunkManifest> {
  const repo = await github.getOrCreateRepo();
  const treeSha = await github.getBranchTreeSha(repo);
  if (!treeSha) throw new Error("repo has no commits");
  const bytes = await github.getFileContent(treeSha, manifestName(fileId));
  return JSON.parse(bytes.toString("utf-8")) as ChunkManifest;
}

/**
 * Build a URL for a hosted endpoint.
 *
 * Prefers the configured public hostname: req.headers.host is whatever the
 * caller dialled, which for an in-cluster client is a .svc address that nothing
 * outside the cluster can resolve.
 */
function buildPublicURL(req: Request, urlPath: string): string {
  if (config.downloadUrls.length > 0) {
    return `https://${config.downloadUrls[0]}${urlPath}`;
  }
  const proto =
    (req.headers["x-forwarded-proto"] as string) ||
    (req.socket && "encrypted" in req.socket ? "https" : "http");
  return `${proto}://${req.headers.host}${urlPath}`;
}

/** Build a direct raw URL for a file stored as a plain repo path. */
function buildRawURL(repoPath: string): string {
  const raw = `https://raw.githubusercontent.com/${config.github.repo}/${config.github.branch}/${repoPath}`;
  if (config.downloadUrls.length === 0) return raw;
  return raw.replace("raw.githubusercontent.com", config.downloadUrls[0]);
}

/**
 * Limit how many operations run at once, with a bounded waiting queue.
 *
 * `acquire` resolves to a release function, or to null when the queue is full —
 * the caller distinguishes "wait your turn" from "come back later".
 */
function createGate(concurrency: number, maxQueue: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  // Idempotent: a slot is released either by the handler finishing or by the
  // client aborting, whichever comes first.
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    };
  };

  return {
    async acquire(): Promise<(() => void) | null> {
      if (active < concurrency) {
        active += 1;
        return makeRelease();
      }
      if (waiting.length >= maxQueue) return null;
      await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      return makeRelease();
    },
  };
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
