/**
 * Shared request limits.
 *
 * Kept out of routes/files.ts so the config endpoint can publish them without
 * importing the router, and so a client can discover them rather than
 * hardcoding a copy that drifts from the server's.
 */
import { CHUNK_SIZE } from "./chunk.js";

/**
 * Largest chunk the server will accept, independent of the configured chunk
 * size.
 *
 * The configured size is what this server *advertises* and what a client should
 * use, but it is not a hard contract: a page or script loaded before the
 * operator changed the setting is still sending the old size, and rejecting it
 * would break uploads for every client that had not reloaded. So the cap is
 * this server's own size or the previous default, whichever is larger — enough
 * that a client one config change behind is still accepted, which is the case
 * that actually happens.
 *
 * It is deliberately not inflated further: the cap is also the worst-case
 * memory bound. A chunk is buffered, base64-encoded and JSON-serialized before
 * it is sent upstream, so it costs roughly 3x its size at peak, and
 * MAX_CONCURRENT_CHUNKS of them can be in flight at once. At 16MB and 8
 * concurrent that is ~384MB — comfortable inside the 1GiB pod limit, whereas a
 * much larger cap would not be.
 */
export const MAX_CHUNK_BYTES = Math.max(CHUNK_SIZE, 16 * 1024 * 1024);

/**
 * Largest body accepted by the single-request upload path.
 *
 * Deliberately NOT tied to CHUNK_SIZE: the two bound different things. The
 * chunk size is the retry granularity for a large file, so it wants to be
 * small; this is the point at which a file stops being worth splitting at all,
 * so lowering the chunk size should not drag this down and push medium files
 * through the chunked protocol for no reason.
 *
 * It is bounded by MAX_CHUNK_BYTES so that the two endpoints agree on what a
 * body may weigh; anything above that is refused at the CDN edge before it
 * reaches this process, so accepting it here would be a promise the deployment
 * cannot keep.
 *
 * Overridable with MAX_SIMPLE_UPLOAD. Multer spools this path to a temp file,
 * but the blob write then reads and encodes it whole, so raising it is a memory
 * decision as much as a throughput one.
 */
function resolveMaxSimpleUpload(): number {
  const configured = parseInt(process.env.MAX_SIMPLE_UPLOAD || "", 10);
  const size = Number.isFinite(configured) && configured > 0 ? configured : 16 * 1024 * 1024;
  return Math.min(size, MAX_CHUNK_BYTES);
}

export const MAX_SIMPLE_UPLOAD = resolveMaxSimpleUpload();
