import { createHash } from "node:crypto";

/**
 * Chunk size used when splitting a file across requests.
 *
 * The CDN body limit (100MB on Cloudflare's lower plans) sets the ceiling; this
 * sits far below it. It is not pushed higher because of the memory cost on the
 * receiving end: writing a chunk to GitHub goes through base64 encoding and
 * JSON serialization, which peaks at roughly 7x the chunk size per in-flight
 * request. 16MB keeps a single chunk around 120MB of transient heap, so a few
 * concurrent uploads still fit inside the pod's memory limit.
 */
export const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB

/**
 * How many chunk bodies the server will process at once, and how many more it
 * will let wait.
 *
 * The browser picks its own request concurrency, and several users upload at
 * the same time, so without a bound here the process memory is a function of
 * client behaviour. Requests beyond the queue limit are refused with a
 * retryable 503 rather than accepted and allowed to exhaust memory.
 */
export const MAX_CONCURRENT_CHUNKS = 2;
export const MAX_QUEUED_CHUNKS = 32;

export interface ChunkManifestPart {
  index: number;
  name: string;
  size: number;
  sha256: string;
  /** Git blob sha for this chunk, so a download can fetch it directly. */
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
 * How a file's content_hash is built.
 *
 * A browser cannot hash a file incrementally — SubtleCrypto has no streaming
 * API — so hashing the whole file would mean holding all of it in memory, which
 * defeats the point of chunked upload. Instead each chunk is hashed on its own
 * (bounded memory), and the file digest is the sha256 of those digests
 * concatenated in order. That is deterministic and content-addressed, which is
 * all an upload id needs; it is deliberately not the sha256 of the file bytes,
 * and the manifest records which algorithm produced it.
 */
export const HASH_ALGORITHM = "sha256-chunked-v1";

/**
 * Derive the stored file's id from its content hash, truncated to 32 hex chars.
 *
 * Because the id is content-addressed, a client retrying the same file
 * addresses the same chunk paths instead of scattering duplicates, and chunks of
 * identical content resolve to the same git blob without a second write.
 */
export function fileIdFromContentHash(contentSha256: string): string {
  return contentSha256.substring(0, UPLOAD_ID_LENGTH);
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
