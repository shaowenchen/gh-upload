/**
 * Shared request limits.
 *
 * Kept out of routes/files.ts so the config endpoint can publish them without
 * importing the router, and so a client can discover them rather than
 * hardcoding a copy that drifts from the server's.
 */
import { CHUNK_SIZE } from "./chunk.js";

/**
 * Largest body accepted by the single-request upload path.
 *
 * Anything larger must use the chunked endpoints: the CDN edge rejects a bigger
 * body before it reaches this process, so accepting one here is not possible.
 */
export const MAX_SIMPLE_UPLOAD = CHUNK_SIZE;
