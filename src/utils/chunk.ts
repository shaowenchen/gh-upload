import { createHash } from "node:crypto";
import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import * as path from "node:path";
import { GitHubService } from "../services/github.js";

export const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB

export interface ChunkManifest {
  version: number;
  file_id: string;
  original_name: string;
  content_type: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  sha256: string;
  chunks: ChunkManifestPart[];
  created_at: number;
}

export interface ChunkManifestPart {
  index: number;
  name: string;
  size: number;
  sha256: string;
}

export function buildFileID(originalName: string, size: number, createdAt: number): string {
  const sum = createHash("sha256")
    .update(`${originalName}:${size}:${createdAt}:${Date.now() * 1e6}`)
    .digest("hex");
  return sum.substring(0, 32);
}

export function sanitizeFilename(name: string): string {
  name = path.basename(name);
  name = name.replace(/\//g, "_").replace(/\\/g, "_");
  if (name === "." || name === "") return "file";
  return name;
}

export function partName(fileId: string, index: number, total: number): string {
  return `${fileId}.part.${String(index).padStart(6, "0")}-of-${String(total).padStart(6, "0")}`;
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

export function splitTime(str: string): [number, string] {
  const index = str.indexOf("-");
  if (index === -1) return [0, str];
  const timeStamp = parseInt(str.substring(0, index), 10) || 0;
  return [timeStamp, str.substring(index + 1)];
}

export async function saveLargeFile(
  github: GitHubService,
  filePath: string,
  originalName: string,
  contentType: string,
  size: number
): Promise<ChunkManifest> {
  const createdAt = Math.floor(Date.now() / 1000);
  const fileId = buildFileID(originalName, size, createdAt);
  const totalChunks = Math.ceil(size / CHUNK_SIZE);

  const manifest: ChunkManifest = {
    version: 1,
    file_id: fileId,
    original_name: originalName,
    content_type: contentType,
    size,
    chunk_size: CHUNK_SIZE,
    total_chunks: totalChunks,
    sha256: "",
    chunks: [],
    created_at: createdAt,
  };

  const fd = openSync(filePath, "r");
  const totalHash = createHash("sha256");
  const buffer = Buffer.alloc(CHUNK_SIZE);

  try {
    for (let index = 1; index <= totalChunks; index++) {
      const bytesRead = readSync(fd, buffer, 0, CHUNK_SIZE, (index - 1) * CHUNK_SIZE);
      if (bytesRead === 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      totalHash.update(chunk);
      const chunkHash = createHash("sha256").update(chunk).digest("hex");

      const part: ChunkManifestPart = {
        index,
        name: partName(fileId, index, totalChunks),
        size: bytesRead,
        sha256: chunkHash,
      };

      const result = await github.uploadContent(part.name, Buffer.from(chunk));
      if (!result) throw new Error(`upload chunk ${part.name} failed`);

      manifest.chunks.push(part);
    }
  } finally {
    closeSync(fd);
  }

  manifest.sha256 = totalHash.digest("hex");

  const manifestJson = JSON.stringify(manifest, null, 2);
  const result = await github.uploadContent(manifestName(fileId), Buffer.from(manifestJson, "utf-8"));
  if (!result) throw new Error(`upload manifest ${manifestName(fileId)} failed`);

  return manifest;
}

export async function reassembleFile(
  github: GitHubService,
  repo: { name: string; defaultBranch: string },
  manifest: ChunkManifest
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const totalHash = createHash("sha256");

  for (const part of manifest.chunks) {
    const content = await github.downloadFile(repo, part.name);
    const partHash = createHash("sha256").update(content).digest("hex");
    if (partHash !== part.sha256) {
      throw new Error("chunk checksum mismatch");
    }
    chunks.push(content);
    totalHash.update(content);
  }

  const assembled = Buffer.concat(chunks);
  if (totalHash.digest("hex") !== manifest.sha256) {
    throw new Error("file checksum mismatch");
  }
  return assembled;
}