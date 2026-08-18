import { describe, expect, it } from "vitest";
import { parseLoginToken } from "./login-link";

describe("parseLoginToken", () => {
  it("reads the token from a full sign-in link", () => {
    expect(
      parseLoginToken(
        "https://ads.example.com/api/session/verify?token=abc123",
      ),
    ).toBe("abc123");
  });

  it("reads the token from a copied path", () => {
    expect(parseLoginToken(" /api/session/verify?token=abc123 ")).toBe(
      "abc123",
    );
  });

  it("accepts a bare token", () => {
    expect(parseLoginToken("abc-123_XYZ.4")).toBe("abc-123_XYZ.4");
  });

  it("rejects empty input, prose, and links without a token", () => {
    expect(parseLoginToken("   ")).toBeNull();
    expect(parseLoginToken("check your inbox")).toBeNull();
    expect(parseLoginToken("https://ads.example.com/login")).toBeNull();
  });
});
