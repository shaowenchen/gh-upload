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
  newFileId,
  partsOfFileId,
  fileIdFromPathParts,
  isValidIdPrefix,
  isValidFileId,
  isValidUploadId,
  sanitizeFilename,
  isManifestName,
  manifestName,
  partName,
  contentHashFromBlobs,
  LEGACY_ID_PATTERN,
  MAX_CONCURRENT_CHUNKS,
  MAX_QUEUED_CHUNKS,
  type ChunkManifest,
} from "../utils/chunk.js";
import { MAX_SIMPLE_UPLOAD, MAX_CHUNK_BYTES } from "../utils/limits.js";
import { signPath, verifyPath } from "../utils/signing.js";

/**
 * Types a browser renders inline that cannot execute script.
 *
 * Uploads are unauthenticated, so anyone can store arbitrary bytes — anything
 * scriptable here would be stored XSS on this origin. Never add html, svg or
 * xml. `nosniff` below is what makes the declared type the one that is used.
 */
const PREVIEWABLE =
  /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|wav|webm)|application\/(pdf|json)|text\/(?!html$|xml$))/;

/** MIME by extension, for files uploaded with no type (upload.sh sends none). */
const BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav",
  pdf: "application/pdf", json: "application/json",
  txt: "text/plain", log: "text/plain", md: "text/plain", csv: "text/plain",
};

/** The declared type, or one from the extension when the client declared none. */
function typeOf(name: string, declared: string): string {
  const type = (declared || "").split(";")[0].trim().toLowerCase();
  if (type && type !== "application/octet-stream") return type;
  // No dot leaves the whole name as the key, which matches nothing.
  return BY_EXT[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? type;
}

const upload = multer({ dest: os.tmpdir() });

const LIST_CONCURRENCY = 8;

/** Bounds concurrent chunk writes, whose ~3x transient heap cost would otherwise scale with client count. */
const chunkGate = createGate(MAX_CONCURRENT_CHUNKS, MAX_QUEUED_CHUNKS);

export const filesRouter = Router();

/**
 * Admit a chunk request only when there is room to hold its body.
 *
 * Runs before express.raw because buffering the body is the expensive part:
 * gating after it would bound only the encoding while every request had already
 * claimed a full chunk of memory.
 */
async function admitChunk(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const release = await chunkGate.acquire();
  if (!release) {
    // Drain the refused body before replying: answering mid-write makes Node
    // destroy the socket, so the client sees a connection reset instead of this
    // retryable 503.
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
    // Client-chosen id for an upload in progress, unrelated to the file's id,
    // so the legacy 32-hex shape is all that is required here.
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
    // Each chunk is its own blob and the manifest records the size actually
    // received, so any size up to the cap is accepted; /complete validates the
    // real sizes, which is what lets a client holding a cached old chunk size
    // still finish.
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
// A git blob cannot be concatenated, so the chunks are the storage: this commits
// the chunk blobs together with the manifest describing their order, in one
// commit.
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
  // Each entry may be the blob id alone or an object carrying it, so a shell
  // script and the browser can both post what they hold. Sizes are not accepted
  // from the client: they are deterministic from the total, and a wrong one
  // would produce a corrupt file rather than an error.
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

  // The split is taken from the client rather than assumed, because a sender
  // with a cached page may still hold an older chunk size; only the total size
  // and chunk size are needed to place every slice, the last taking the rest.
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
  // The last chunk holds the remainder and must hold at least one byte.
  const lastChunkSize = size - chunkSize * (totalChunks - 1);
  if (lastChunkSize <= 0) {
    showError(
      res,
      `size ${size} is too small for ${totalChunks} chunks of ${chunkSize} bytes`,
      400
    );
    return;
  }

  // Kept for integrity checks; no longer part of the address, which is the
  // timestamp and the name.
  const contentHash = contentHashFromBlobs(chunks.map((c) => c.blob_sha));
  const fileId = newFileId(originalName, Date.now());
  const manifest: ChunkManifest = {
    version: 2,
    file_id: fileId,
    original_name: originalName,
    content_type: String(body.content_type ?? "application/octet-stream"),
    size,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    content_hash: contentHash,
    chunks: chunks.map((c) => ({
      index: c.index,
      name: partName(fileId, c.index, totalChunks),
      // The last chunk takes the remainder, absorbing any difference between the
      // client's chunk size and this server's.
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

    // Chunk blobs land in the same commit as the manifest, so an upload is
    // either fully visible or not at all — and until then the blobs are
    // unreferenced, hence invisible and garbage-collected by GitHub.
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
    const fileId = newFileId(originalName, Date.now());

    // Stored in the same shape as a chunked upload rather than as a bare repo
    // path: a bare path could only be served by linking to
    // raw.githubusercontent.com, which bypasses this server and so cannot be
    // signed, given an expiry, or kept private.
    const manifest: ChunkManifest = {
      version: 2,
      file_id: fileId,
      original_name: originalName,
      content_type: file.mimetype || "application/octet-stream",
      size: file.size,
      chunk_size: content.length,
      total_chunks: 1,
      content_hash: contentHash,
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

    // Anything else in the tree (the bootstrap README) is not a managed file.
    const manifests: string[] = [];
    for (const path of entries.keys()) {
      if (isManifestName(path)) manifests.push(path);
    }

    // The tree already gives every plain file's size, so only manifests read a
    // body; those fetch concurrently.
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
//
// The id is accepted whole rather than split into path segments, so both
// `<timestamp>-<name>` and legacy content-hash ids resolve here.
filesRouter.get("/:id", async (req, res) => {
  const fileId = req.params.id;
  if (!isValidFileId(fileId)) {
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
      content_type: manifest.content_type,
      created_at: manifest.created_at,
      total_chunks: manifest.total_chunks,
      download_url: downloadURL(req, fileId),
    });
  } catch {
    showError(res, "file not found", 404);
  }
});

// GET /api/v1/files/:prefix/:name - Stream a file back to the client
//
// The two segments are the id read back apart, so a client that names its output
// from the URL (wget without -O, "save link as") lands on the real filename. The
// name is part of the address, so editing it addresses a path that does not
// exist — a 404, not a rename.
filesRouter.get("/:prefix/:name", async (req, res) => {
  const fileId = fileIdFromPathParts(req.params.prefix, req.params.name);
  if (!isValidIdPrefix(req.params.prefix)) {
    showError(res, "invalid file id", 400);
    return;
  }

  // When signing is configured, the link's expiry and signature are part of
  // the authorization. A link that has aged out is a normal outcome, not an
  // error in the request, so it says which it is and how to get a new one.
  const check = verifyPath(signedPathFor(req.params.prefix), {
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

    // The name is part of the file's address, so a name segment that does not
    // match the file it resolved to is a request for a file that does not
    // exist — not a decorative suffix to ignore. Without this a typo or a stale
    // name would silently download the right bytes under the wrong URL.
    //
    // Legacy ids have no name segment to check against: their storage path had
    // none, so whatever the URL carries is the old shape and is left alone.
    if (!LEGACY_ID_PATTERN.test(req.params.prefix) &&
        req.params.name !== manifest.original_name) {
      showError(res, "no file at this name", 404);
      return;
    }

    // Preview by default where a browser renders it safely; ?download=1 forces
    // the save dialog. The type is gated, not trusted, and nosniff keeps the
    // browser on the declared type instead of sniffing the bytes.
    const type = typeOf(manifest.original_name, manifest.content_type);
    const previewing = req.query.download === undefined && PREVIEWABLE.test(type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Type",
      previewing && type.startsWith("text/")
        ? "text/plain; charset=utf-8"
        : previewing
          ? type
          : manifest.content_type || "application/octet-stream"
    );
    // Non-ASCII names need both forms: a quoted fallback for simple clients and
    // the RFC 5987 filename* for anything that understands it. Percent-encoding
    // inside a plain filename= would be taken literally.
    res.setHeader(
      "Content-Disposition",
      `${previewing ? "inline" : "attachment"}; ` +
        `filename="${asciiFallback(manifest.original_name)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(manifest.original_name)}`
    );
    // The manifest knows the total size, so this stays a plain response rather
    // than chunked transfer encoding.
    res.setHeader("Content-Length", manifest.size);

    await streamChunks(github, manifest, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      // Distinguish the two failures, because only one of them is the caller's
      // to act on. A 404 means this id has no manifest; anything else is this
      // server failing to read a repository it can write to, and reporting that
      // as 404 sends the caller looking for a problem that is not at their end.
      const status = (err as { status?: number }).status;
      const missing = status === 404 || /not a file|file not found/.test(String((err as Error)?.message));
      showError(res, missing ? "file not found" : "read manifest failed", missing ? 404 : 502);
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

/**
 * Load a file's manifest.
 *
 * The manifest is addressed by its own path, not discovered by walking the
 * tree: a tree walk silently returns a partial listing on a large repository,
 * which turns a file that exists into "not found".
 */
async function loadManifest(
  github: GitHubService,
  fileId: string
): Promise<ChunkManifest> {
  const bytes = await github.getFileContent(manifestName(fileId));
  return JSON.parse(bytes.toString("utf-8")) as ChunkManifest;
}

/**
 * The path a download link's signature is taken over.
 *
 * Keyed on the timestamp segment rather than the full request path: the name is
 * part of the address but not part of the file's identity, so signing only the
 * prefix keeps a link's validity independent of how the name is spelled while
 * still pinning it to one file.
 */
function signedPathFor(prefix: string): string {
  return `/api/v1/files/${prefix}`;
}

/**
 * Build a signed download URL for a file.
 *
 * Prefers the configured public hostname: req.headers.host is whatever the
 * caller dialled, which for an in-cluster client is a .svc address that nothing
 * outside the cluster can resolve.
 */
function downloadURL(req: Request, fileId: string): string {
  // The id's two halves are presented as separate path segments, so the URL
  // reads `/<timestamp>/<name>` rather than repeating the name on the end.
  const { prefix, name } = partsOfFileId(fileId);
  const path = `${signedPathFor(prefix)}${name ? `/${encodeURIComponent(name)}` : ""}`;
  const base =
    config.downloadUrls.length > 0
      ? `https://${config.downloadUrls[0]}`
      : (() => {
          const proto =
            (req.headers["x-forwarded-proto"] as string) ||
            (req.socket && "encrypted" in req.socket ? "https" : "http");
          return `${proto}://${req.headers.host}`;
        })();
  // Signed over the path (not the host, and not the name) so the same signature
  // remains valid whichever hostname the link is reached through.
  return `${base}${path}${signPath(signedPathFor(prefix))}`;
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
