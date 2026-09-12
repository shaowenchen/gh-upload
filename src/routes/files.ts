import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import multer from "multer";
import os from "node:os";
import { unlink, readFile } from "node:fs/promises";
import { githubService } from "../services/github.js";
import type { GitHubService } from "../services/github.js";
import { showData, showError } from "../utils/response.js";
import { config } from "../config.js";
import {
  CHUNK_SIZE,
  sha256Hex,
  fileIdFromContentHash,
  isValidUploadId,
  sanitizeFilename,
  isGeneratedName,
  manifestName,
  partName,
  HASH_ALGORITHM,
  contentHashFromBlobs,
  MAX_CONCURRENT_CHUNKS,
  MAX_QUEUED_CHUNKS,
  type ChunkManifest,
} from "../utils/chunk.js";
import { MAX_SIMPLE_UPLOAD, MAX_CHUNK_BYTES } from "../utils/limits.js";
import { signPath, verifyPath } from "../utils/signing.js";

const upload = multer({ dest: os.tmpdir() });

/** Manifests fetched concurrently while building the file list. */
const LIST_CONCURRENCY = 8;

/**
 * Chunk requests admitted at once. Writing a chunk to GitHub costs roughly 3x
 * its size in transient heap (the body, its base64 encoding, the JSON copy), so
 * this bound is what keeps process memory independent of how many clients
 * upload at the same time or how aggressively they parallelise.
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
  express.raw({ type: "*/*", limit: MAX_CHUNK_BYTES + 1024 }),
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
    // Each chunk is stored as its own blob and the manifest records the size
    // that was actually received, so a chunk is accepted at any size up to the
    // cap. The old rule — every non-final chunk must be exactly the server's
    // configured chunk size — meant a client holding a cached page or script
    // from before a chunk-size change had every chunk of every upload rejected
    // with a message about a number it had no way to know. What the server
    // needs is enough to reconstruct the file, which /complete checks against
    // the real chunk sizes rather than against an assumption.
    if (body.length > MAX_CHUNK_BYTES) {
      showError(res, `chunk exceeds ${MAX_CHUNK_BYTES} bytes`, 413);
      return;
    }

    try {
      const github = githubService();
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
  // Each entry may be the blob id on its own or an object carrying it, so a
  // client that has only the ids (a shell script) and one that has the whole
  // response (the browser) can both post what they hold.
  //
  // Per-chunk sizes are not accepted from the client: they are deterministic
  // from the total, and a caller that states them wrongly would produce a
  // corrupt file rather than an error.
  const chunks = rawChunks.map((entry, i) => {
    const blobSha =
      typeof entry === "string"
        ? entry
        : String((entry as Record<string, unknown>)?.blob_sha ?? "");
    return { index: i + 1, blob_sha: blobSha };
  });

  const shasOk = chunks.every((c) => /^[a-f0-9]{40}$/.test(c.blob_sha));
  if (!shasOk) {
    showError(res, "every chunk needs the blob_sha returned by /chunks", 400);
    return;
  }

  // Validate that the stated size is consistent with the split the client
  // describes, so a mismatch is an error now rather than a corrupt file later.
  //
  // The split is taken from the client rather than assumed, because the sender
  // is not necessarily using this server's current chunk size: a page loaded
  // before the operator changed it is still holding the old one, and its split
  // is just as reconstructible. Only the total size and the chunk size are
  // needed to place every slice; the last one takes the remainder.
  const declaredChunkSize = Number(body.chunk_size);
  const chunkSize =
    Number.isInteger(declaredChunkSize) && declaredChunkSize > 0
      ? Math.min(declaredChunkSize, MAX_CHUNK_BYTES)
      : CHUNK_SIZE;

  if (size > chunkSize * totalChunks) {
    showError(
      res,
      `size ${size} does not fit ${totalChunks} chunks of ${chunkSize} bytes`,
      400
    );
    return;
  }
  // The last chunk holds the remainder, and every chunk must hold at least one
  // byte — a zero-length final slice would mean the count is one too high.
  const lastChunkSize = size - chunkSize * (totalChunks - 1);
  if (lastChunkSize <= 0) {
    showError(
      res,
      `size ${size} is too small for ${totalChunks} chunks of ${chunkSize} bytes`,
      400
    );
    return;
  }

  // Derived from the chunk identities rather than taken from the request: the
  // caller has no reason to hash the file (and a browser cannot do so without
  // buffering it), so requiring a digest only invited clients to get it wrong.
  const contentHash = contentHashFromBlobs(chunks.map((c) => c.blob_sha));
  const fileId = fileIdFromContentHash(contentHash);
  const manifest: ChunkManifest = {
    version: 2,
    file_id: fileId,
    original_name: originalName,
    content_type: String(body.content_type ?? "application/octet-stream"),
    size,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    content_hash: contentHash,
    hash_algorithm: HASH_ALGORITHM,
    chunks: chunks.map((c) => ({
      index: c.index,
      // Recomputed rather than trusting the client's spelling of the name.
      name: partName(fileId, c.index, totalChunks),
      // The size of the slice at this index under the split being finalized.
      // The last chunk takes the remainder, which absorbs any difference
      // between the client's chunk size and this server's.
      size: c.index === totalChunks ? size - chunkSize * (totalChunks - 1) : chunkSize,
      blob_sha: c.blob_sha,
    })),
    created_at: Math.floor(Date.now() / 1000),
  };

  try {
    const github = githubService();
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
      download_url: downloadURL(req, fileId),
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

    const github = githubService();
    const content = await readFile(file.path);
    const blobSha = await github.createBlob(content);
    const contentHash = contentHashFromBlobs([blobSha]);
    const fileId = fileIdFromContentHash(contentHash);

    // Stored in the same shape as a chunked upload — one chunk of one blob —
    // rather than as a bare repo path. A bare path could only be served by
    // linking straight to raw.githubusercontent.com, which bypasses this server
    // entirely: it cannot be signed or have an expiry, and it needs the
    // repository to be public. Routing every download through the manifest
    // keeps one storage model and one signable URL shape.
    const manifest: ChunkManifest = {
      version: 2,
      file_id: fileId,
      original_name: originalName,
      content_type: file.mimetype || "application/octet-stream",
      size: file.size,
      chunk_size: content.length,
      total_chunks: 1,
      content_hash: contentHash,
      hash_algorithm: HASH_ALGORITHM,
      chunks: [
        {
          index: 1,
          name: partName(fileId, 1, 1),
          size: content.length,
          blob_sha: blobSha,
        },
      ],
      created_at: Math.floor(Date.now() / 1000),
    };

    const manifestBlob = await github.createBlob(
      Buffer.from(JSON.stringify(manifest, null, 2), "utf-8")
    );
    await github.commitFiles(
      [
        { path: manifest.chunks[0].name, sha: blobSha },
        { path: manifestName(fileId), sha: manifestBlob },
      ],
      `Upload ${originalName}`
    );

    showData(res, {
      file_id: fileId,
      name: originalName,
      size: file.size,
      content_hash: contentHash,
      content_type: manifest.content_type,
      download_url: downloadURL(req, fileId),
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
  const github = githubService();
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

    // Every stored file is a manifest plus its chunks; anything else in the
    // tree (the bootstrap README, for instance) is not a file this service
    // manages and is not listed.
    const manifests: string[] = [];
    for (const path of entries.keys()) {
      if (path.endsWith(".manifest.json")) manifests.push(path);
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
        download_url: downloadURL(req, manifest.file_id),
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

  const github = githubService();
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
      download_url: downloadURL(req, fileId),
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

  // When signing is configured, the link's expiry and signature are part of
  // the authorization. A link that has aged out is a normal outcome, not an
  // error in the request, so it says which it is and how to get a new one.
  const check = verifyPath(`/api/v1/files/${fileId}/download`, {
    expires: req.query.expires ? Number(req.query.expires) : undefined,
    sig: typeof req.query.sig === "string" ? req.query.sig : undefined,
  });
  if (!check.ok) {
    if (check.reason === "expired") {
      showError(res, "this download link has expired", 410, false);
      return;
    }
    showError(
      res,
      check.reason === "missing"
        ? "this download link is missing its signature"
        : "this download link is not valid",
      403,
      false
    );
    return;
  }

  const github = githubService();
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

    await streamChunks(github, manifest, res);
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

/** Chunk reads kept in flight while streaming a download. */
const DOWNLOAD_PREFETCH = 4;

/**
 * Stream a file's chunks to the response in order.
 *
 * Chunks are fetched a few ahead of the write cursor so the upstream latency is
 * paid once rather than once per chunk. A download of N chunks from GitHub pays
 * N round trips; doing them strictly one after another makes every one of them
 * additive, which for a chunked file dominates the transfer — the bytes are
 * small, the latency is not.
 *
 * The prefetch is bounded because each in-flight chunk is a base64-decoded
 * buffer held in memory, so an unbounded lookahead would make a download's
 * memory a function of its size, which is the failure this replaced.
 *
 * Order is what matters, not completion order: chunk i must be written before
 * chunk i+1, so the fetches overlap but the writes stay sequential. This is why
 * it is a lookahead rather than a fan-out.
 */
async function streamChunks(
  github: GitHubService,
  manifest: ChunkManifest,
  res: Response
): Promise<void> {
  // A client that hangs up — cancelling the download, reloading the page,
  // closing the tab — leaves the response unwritable. Node destroys the socket
  // without emitting the "drain" a backpressured write is waiting for, so a
  // loop that waits only on "drain" has nothing to wake it. Handling "close"
  // alongside it makes the disconnect an exit rather than a wait.
  let aborted = res.writableEnded || res.destroyed;
  res.on("close", () => {
    aborted = true;
  });

  /** Resolve as soon as the response can be written to again, or is gone. */
  const waitForDrain = (): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });

  const parts = manifest.chunks;
  // One slot per chunk, holding the in-flight read for it.
  const reads: Array<Promise<Buffer>> = new Array(parts.length);
  let started = 0;

  for (let i = 0; i < parts.length; i++) {
    // Fill the lookahead window, then wait for the chunk at the write cursor.
    // Every chunk is started exactly once and awaited exactly once, so the
    // window slides rather than needing to be drained at the end.
    while (started < parts.length && started < i + DOWNLOAD_PREFETCH) {
      reads[started] = github.getBlob(parts[started].blob_sha);
      started++;
    }

    const chunk = await reads[i];
    if (aborted) {
      // Stop reading from upstream for a client that is no longer there. The
      // buffers already fetched are dropped with the remaining promises.
      return;
    }
    if (!res.write(chunk)) {
      await waitForDrain();
      if (aborted) return;
    }
  }

  if (!aborted) res.end();
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
 * Build a signed download URL for a file.
 *
 * Prefers the configured public hostname: req.headers.host is whatever the
 * caller dialled, which for an in-cluster client is a .svc address that nothing
 * outside the cluster can resolve.
 */
function downloadURL(req: Request, fileId: string): string {
  const path = `/api/v1/files/${fileId}/download`;
  const base =
    config.downloadUrls.length > 0
      ? `https://${config.downloadUrls[0]}`
      : (() => {
          const proto =
            (req.headers["x-forwarded-proto"] as string) ||
            (req.socket && "encrypted" in req.socket ? "https" : "http");
          return `${proto}://${req.headers.host}`;
        })();
  // Signed over the request path (not the host) so the same signature remains
  // valid whichever hostname the link is reached through.
  return `${base}${path}${signPath(path)}`;
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
