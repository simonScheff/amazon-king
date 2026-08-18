/**
 * Extracts the magic-link token from whatever the user pasted: the whole link
 * from the email, a copied path, or the bare token. Returns null when nothing
 * token-shaped is present, so the caller can say so before touching the API.
 */
export function parseLoginToken(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;

  try {
    const token = new URL(value, window.location.origin).searchParams.get(
      "token",
    );
    if (token !== null && token !== "") return token;
  } catch {
    // Not URL-shaped — fall through to the bare-token case.
  }

  return /^[A-Za-z0-9._~-]+$/.test(value) ? value : null;
}
