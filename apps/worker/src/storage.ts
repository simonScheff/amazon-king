import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Writable } from "node:stream";

/**
 * Local filesystem stand-in for S3 raw report storage (plan §8 import
 * mechanics step 8). Keys mirror the production layout
 * (`<workspaceId>/<profileId>/<reportId>.json.gz`). Writes are streamed to a
 * temp file and atomically renamed into place; a sha256 checksum is computed
 * while streaming so integrity can be verified on read-back.
 */

export interface StoredArtifact {
  key: string;
  checksum: string;
  bytes: number;
}

/** Storage interface handlers depend on; tests substitute an in-memory fake. */
export interface ReportStorage {
  /** Stream-compress nothing: `write` pushes the raw artifact bytes into sink. */
  store(
    key: string,
    write: (sink: Writable) => Promise<void>,
  ): Promise<StoredArtifact>;
  /** Read back a gzip-compressed JSON artifact and parse it. */
  readGzipJson(key: string): Promise<unknown>;
  /** Recompute the sha256 of the stored artifact and compare with expected. */
  verifyChecksum(key: string, expectedChecksum: string): Promise<boolean>;
}

export function createLocalReportStorage(rootDir: string): ReportStorage {
  function pathFor(key: string): string {
    // Guard against path escape: keys are worker-generated, never user input.
    if (key.includes("..")) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return join(rootDir, key);
  }

  return {
    async store(key, write) {
      const finalPath = pathFor(key);
      await mkdir(dirname(finalPath), { recursive: true });
      const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
      const hash = createHash("sha256");
      let bytes = 0;
      const through = new PassThrough();
      through.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
      });
      const done = pipeline(through, createWriteStream(tmpPath));
      try {
        await write(through);
        if (!through.writableEnded) {
          through.end();
        }
        await done;
        await rename(tmpPath, finalPath);
      } catch (error) {
        through.destroy();
        await done.catch(() => undefined);
        await rm(tmpPath, { force: true });
        throw error;
      }
      return { key, checksum: hash.digest("hex"), bytes };
    },

    async readGzipJson(key) {
      const compressed = await readFile(pathFor(key));
      const gunzip = createGunzip();
      const chunks: Buffer[] = [];
      gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
      gunzip.end(compressed);
      await new Promise<void>((resolve, reject) => {
        gunzip.on("end", resolve);
        gunzip.on("error", reject);
      });
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    },

    async verifyChecksum(key, expectedChecksum) {
      const compressed = await readFile(pathFor(key));
      const actual = createHash("sha256").update(compressed).digest("hex");
      return actual === expectedChecksum;
    },
  };
}
