import { createHash } from "node:crypto";

/**
 * Chunk size used when splitting a file across requests.
 *
 * The CDN body limit (100MB on Cloudflare's lower plans) sets the ceiling; this
 * sits far below it.
 *
 * It is not set by the CDN limit but by what a failure costs. Every chunk is a
 * separate request that can fail on its own, so the chunk size is really the
 * retry granularity: at 8MB a dropped connection costs 8MB to re-send, whereas
 * at 32MB it costs four times that. Smaller chunks also let a slow link keep
 * more requests in flight at once, which is what determines throughput when the
 * round trip, not the bandwidth, is the constraint.
 *
 * The memory cost is what stops it going much lower: writing a chunk to GitHub
 * goes through base64 encoding and JSON serialization, peaking at roughly 3x
 * the chunk size per in-flight request. At 8MB that is ~24MB per concurrent
 * chunk, which the default concurrency below keeps well inside the pod's limit.
 *
 * Overridable with CHUNK_SIZE because the right value depends on the deployment
 * — a direct connection to the API can afford larger chunks than one behind a
 * flaky CDN edge.
 */
function resolveChunkSize(): number {
  const configured = parseInt(process.env.CHUNK_SIZE || "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 8 * 1024 * 1024; // 8MB
}

export const CHUNK_SIZE = resolveChunkSize();

/**
 * How many chunk bodies the server will process at once, and how many more it
 * will let wait.
 *
 * The browser and the shell script pick their own request concurrency, and
 * several users upload at the same time, so without a bound here the process
 * memory is a function of client behaviour. Requests beyond the queue limit are
 * refused with a retryable 503 rather than accepted and allowed to exhaust
 * memory.
 *
 * This is published through /api/v1/config, so clients size their in-flight
 * window to what the server will actually accept: a client that asks for more
 * than this converts its own throughput into 503s and backoff sleeps.
 *
 * The default assumes the 1GiB pod limit in deploy/deployment.yaml: at 8MB a
 * chunk peaks around 24MB of transient heap, so 8 in flight is ~200MB, leaving
 * room for the response bodies and the rest of the process.
 */
function resolveConcurrency(): number {
  const configured = parseInt(process.env.MAX_CONCURRENT_CHUNKS || "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 8;
}

export const MAX_CONCURRENT_CHUNKS = resolveConcurrency();

/**
 * Waiting room size. Kept well above the concurrency so a client that briefly
 * overshoots waits for a slot instead of being turned away — a 503 costs it a
 * backoff sleep, which is slower than having queued.
 */
export const MAX_QUEUED_CHUNKS = 64;

export interface ChunkManifestPart {
  index: number;
  name: string;
  size: number;
  /**
   * Git blob id of this chunk. Identifies the content and lets a download fetch
   * it directly, without walking the tree per chunk.
   */
  blob_sha: string;
}

export interface ChunkManifest {
  version: number;
  file_id: string;
  original_name: string;
  content_type: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  /**
   * File identity, derived from the chunk digests rather than by hashing the
   * whole file. See hash_algorithm for the exact construction.
   */
  content_hash: string;
  hash_algorithm: string;
  chunks: ChunkManifestPart[];
  created_at: number;
}

const UPLOAD_ID_LENGTH = 32;
const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/;
const TIMESTAMP_PREFIX_PATTERN = /^(\d{10})-(.+)$/;

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * How a stored file's content_hash is derived.
 *
 * The digest is taken over the ordered git blob ids of the chunks rather than
 * over the file bytes. Clients therefore never hash the file — which matters
 * because a browser cannot hash a stream, so hashing the whole file would mean
 * buffering all of it, defeating the point of chunked upload.
 *
 * It is deterministic and content-addressed (git blob ids are) but it is
 * deliberately NOT the sha256 of the file, and the manifest says which
 * algorithm produced it.
 */
export const HASH_ALGORITHM = "sha256-git-blob-ids-v1";

/** Stable identity for a file, from the ordered blob ids of its chunks. */
export function contentHashFromBlobs(blobShas: string[]): string {
  return sha256Hex(blobShas.join(""));
}

/**
 * Derive the stored file's id from its content hash, truncated to 32 hex chars.
 *
 * Because the id is content-addressed, uploading the same file twice addresses
 * the same chunk paths instead of scattering duplicates, and chunks of
 * identical content resolve to the same git blob without a second write.
 */
export function fileIdFromContentHash(contentHash: string): string {
  return contentHash.substring(0, UPLOAD_ID_LENGTH);
}

export function isValidUploadId(id: string): boolean {
  return UPLOAD_ID_PATTERN.test(id);
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() || "";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
  return cleaned;
}

export function partName(fileId: string, index: number, total: number): string {
  const width = Math.max(6, String(total).length);
  return `${fileId}.part.${String(index).padStart(width, "0")}-of-${String(total).padStart(width, "0")}`;
}

export function manifestName(fileId: string): string {
  return `${fileId}.manifest.json`;
}

export function isChunkPartName(name: string): boolean {
  return name.includes(".part.") && name.includes("-of-");
}

export function isManifestName(name: string): boolean {
  return name.endsWith(".manifest.json");
}

/** Storage names this service creates itself, as opposed to user uploads. */
export function isGeneratedName(name: string): boolean {
  return isChunkPartName(name) || isManifestName(name);
}

/**
 * Split a `<epoch>-<filename>` storage name back into its parts.
 *
 * The timestamp is matched as an anchored 10-digit prefix rather than "up to
 * the first dash", so a file legitimately named `2024-report.pdf` is not
 * misread as a timestamp and does not poison the sort order.
 */
export function splitTime(str: string): [number, string] {
  const match = TIMESTAMP_PREFIX_PATTERN.exec(str);
  if (!match) return [0, str];
  return [parseInt(match[1], 10), match[2]];
}

/** Storage path for a single-request upload. */
export function simpleStoragePath(originalName: string, now: number): string {
  return `${Math.floor(now / 1000)}-${originalName}`;
}
