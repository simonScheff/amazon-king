import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret } from "./index.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("token envelope encryption", () => {
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY_V2;
  });

  it("round-trips a secret", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const { ciphertext, keyVersion } = encryptSecret("refresh-token-123");
    expect(keyVersion).toBe(CURRENT_KEY_VERSION);
    expect(decryptSecret(ciphertext)).toBe("refresh-token-123");
  });

  it("never embeds the plaintext in the ciphertext", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const { ciphertext } = encryptSecret("refresh-token-123");
    expect(ciphertext.includes(Buffer.from("refresh-token-123"))).toBe(false);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("rejects tampered ciphertext", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const { ciphertext } = encryptSecret("secret");
    ciphertext[ciphertext.length - 1] ^= 0xff;
    expect(() => decryptSecret(ciphertext)).toThrow();
  });

  it("rejects the wrong key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const { ciphertext } = encryptSecret("secret");
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    expect(() => decryptSecret(ciphertext)).toThrow();
  });

  it("supports versioned keys for rotation", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    process.env.TOKEN_ENCRYPTION_KEY_V2 = KEY_B;
    const v1 = encryptSecret("old", 1);
    const v2 = encryptSecret("new", 2);
    expect(decryptSecret(v1.ciphertext)).toBe("old");
    expect(decryptSecret(v2.ciphertext)).toBe("new");
  });

  it("fails clearly when the master key is missing or malformed", () => {
    expect(() => encryptSecret("x")).toThrow(/TOKEN_ENCRYPTION_KEY/);
    process.env.TOKEN_ENCRYPTION_KEY = "not-hex";
    expect(() => encryptSecret("x")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
