/**
 * Envelope encryption for Amazon refresh tokens (dev/local stand-in for a
 * cloud KMS design; plan §13). The master key comes from the
 * TOKEN_ENCRYPTION_KEY env var as 64 hex chars (32 bytes). Ciphertexts are
 * stored in `amazon_connections.encrypted_refresh_token` (bytea) together
 * with `encryption_key_version`, so keys can be rotated by adding a new
 * version without re-encrypting old rows up front.
 *
 * Format: keyVersion (uint16 BE) | iv (12 bytes) | authTag (16 bytes) | ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CURRENT_KEY_VERSION = 1;

const VERSION_LEN = 2;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Load the master key for a version from the environment. */
function masterKey(version: number): Buffer {
  // Versioned env vars (TOKEN_ENCRYPTION_KEY_V2 etc.) take precedence so a
  // rotation only requires adding a new env var; version 1 falls back to the
  // unversioned TOKEN_ENCRYPTION_KEY.
  const envName =
    version === 1 ? "TOKEN_ENCRYPTION_KEY" : `TOKEN_ENCRYPTION_KEY_V${version}`;
  const hex = process.env[envName];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `${envName} must be set to 64 hex characters (32 bytes) to encrypt/decrypt Amazon tokens`,
    );
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  keyVersion: number;
}

/** Encrypt a UTF-8 secret. Never log the plaintext or the returned key material. */
export function encryptSecret(
  plaintext: string,
  keyVersion: number = CURRENT_KEY_VERSION,
): EncryptedSecret {
  const key = masterKey(keyVersion);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const header = Buffer.alloc(VERSION_LEN);
  header.writeUInt16BE(keyVersion, 0);
  return {
    ciphertext: Buffer.concat([header, iv, tag, encrypted]),
    keyVersion,
  };
}

/** Decrypt a ciphertext produced by encryptSecret. Throws on tamper/wrong key. */
export function decryptSecret(ciphertext: Buffer): string {
  if (ciphertext.length < VERSION_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error("Ciphertext too short to be valid");
  }
  const keyVersion = ciphertext.readUInt16BE(0);
  const key = masterKey(keyVersion);
  const iv = ciphertext.subarray(VERSION_LEN, VERSION_LEN + IV_LEN);
  const tag = ciphertext.subarray(
    VERSION_LEN + IV_LEN,
    VERSION_LEN + IV_LEN + TAG_LEN,
  );
  const encrypted = ciphertext.subarray(VERSION_LEN + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}
