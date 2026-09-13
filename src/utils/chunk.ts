import { createHash } from "node:crypto";

/** Chunk size for split uploads. Smaller means a failed chunk costs less to re-send. */
function resolveChunkSize(): number {
  const configured = parseInt(process.env.CHUNK_SIZE || "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 8 * 1024 * 1024; // 8MB
}

export const CHUNK_SIZE = resolveChunkSize();

/** Chunk bodies processed at once. Sized to keep peak heap inside the pod limit. */
function resolveConcurrency(): number {
  const configured = parseInt(process.env.MAX_CONCURRENT_CHUNKS || "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 8;
}

export const MAX_CONCURRENT_CHUNKS = resolveConcurrency();

/** Waiting room above the concurrency, so a brief overshoot queues instead of 503ing. */
export const MAX_QUEUED_CHUNKS = 64;

export interface ChunkManifestPart {
  index: number;
  name: string;
  size: number;
  /** Git blob id, so a download fetches the chunk without a tree walk. */
  blob_sha: string;
}

export interface ChunkManifest {
  version: number;
  /** Repository path prefix: `<epoch millis>-<name>`. Legacy files hold a bare hash. */
  file_id: string;
  original_name: string;
  content_type: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  /** Digest over the ordered chunk blob ids; recorded, not addressed. */
  content_hash: string;
  chunks: ChunkManifestPart[];
  created_at: number;
}

/** Ids issued before ids carried a timestamp and a name. No name segment to check. */
export const LEGACY_ID_PATTERN = /^[a-f0-9]{32}$/;

export function contentHashFromBlobs(blobShas: string[]): string {
  return createHash("sha256").update(blobShas.join("")).digest("hex");
}

/**
 * Id for a new upload. Nothing is read or hashed to place a file, which is what
 * makes this immediate. Same millisecond *and* same name collides, and the later
 * commit replaces the earlier manifest.
 */
export function newFileId(originalName: string, now: number): string {
  return `${Math.floor(now / 1000) * 1000}-${sanitizeFilename(originalName)}`;
}

/** Split an id into the two URL segments: `/<timestamp>/<name>`. */
export function partsOfFileId(fileId: string): { prefix: string; name: string } {
  if (LEGACY_ID_PATTERN.test(fileId)) return { prefix: fileId, name: "" };
  const separator = fileId.indexOf("-");
  if (separator === -1) return { prefix: fileId, name: "" };
  return { prefix: fileId.slice(0, separator), name: fileId.slice(separator + 1) };
}

/** Rebuild storage id from URL segments. The name participates in addressing. */
export function fileIdFromPathParts(prefix: string, name: string): string {
  return LEGACY_ID_PATTERN.test(prefix) ? prefix : `${prefix}-${sanitizeFilename(name)}`;
}

export function isValidIdPrefix(prefix: string): boolean {
  return LEGACY_ID_PATTERN.test(prefix) || /^\d{13}$/.test(prefix);
}

export function isValidFileId(id: string): boolean {
  return LEGACY_ID_PATTERN.test(id) || /^\d{13}-\S.*$/.test(id);
}

/** Client-chosen session id for an upload in progress; addresses nothing. */
export function isValidUploadId(id: string): boolean {
  return LEGACY_ID_PATTERN.test(id);
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() || "";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
  return cleaned;
}

/**
 * Repair a filename whose UTF-8 bytes were read as Latin-1.
 *
 * busboy, which multer parses multipart bodies with, decodes the `filename`
 * parameter as Latin-1 instead of UTF-8. A browser sends the name as raw UTF-8
 * bytes, so "平凡.pdf" arrives as "å¹³å¡.pdf" — every byte of the original
 * promoted to its own code point. The name is not merely displayed: it becomes
 * the file's storage path, so the damaged spelling is what gets committed and
 * what every link derived from it carries.
 *
 * The repair inverts that: narrow each code point back to a byte, then read the
 * bytes as UTF-8. It is applied only when the name is entirely Latin-1 *and*
 * survives the round trip, which is what keeps it off names that are not
 * damaged — an ASCII name never matches the first test, and a genuinely
 * Latin-1 name ("café.pdf", one byte per accented character, decoded
 * correctly by busboy) decodes back non-UTF-8 and is left alone. A name whose
 * bytes are not valid UTF-8 would decode to replacement characters, so those
 * are kept as received rather than silently corrupted.
 */
export function normalizeFilename(name: string): string {
  // No byte was promoted, or the name is already beyond Latin-1 — either way
  // there is nothing busboy could have damaged.
  if (!/^[\x00-\xff]*$/.test(name) || !/[\x80-\xff]/.test(name)) return name;
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  // Replacement characters mean those bytes were not UTF-8 to begin with, so
  // the original is the more faithful of the two.
  if (decoded.includes("�")) return name;
  return decoded;
}

/**
 * Percent-encode a name for the RFC 5987 `filename*` parameter.
 *
 * `encodeURIComponent` leaves `!'()*` literal. Those are legal in an extended
 * parameter, but an apostrophe especially is not worth the ambiguity: it is the
 * delimiter the parameter itself is built from, and a parser that splits on it
 * rather than scanning from the charset prefix reads the rest as a language
 * tag. Narrowing the set to unreserved characters costs a few bytes and leaves
 * nothing for a parser to guess at.
 */
export function encodeRFC5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()!*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

export function partName(fileId: string, index: number, total: number): string {
  const width = Math.max(6, String(total).length);
  return `${fileId}.part.${String(index).padStart(width, "0")}-of-${String(total).padStart(width, "0")}`;
}

export function manifestName(fileId: string): string {
  return `${fileId}.manifest.json`;
}

export function isManifestName(name: string): boolean {
  return name.endsWith(".manifest.json");
}
