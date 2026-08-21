/**
 * Search-term reports put ASINs in the same column as text queries when an
 * auto or product target matched a product detail page; Amazon provides no
 * explicit flag. ASINs are 10 alphanumeric characters; KDP ebooks start with
 * "B0" and KDP print books reuse their ISBN-10 (nine digits plus a digit or
 * "X" check digit), so the pair of shapes is a reliable heuristic. A bare
 * ten-letter word like "bestseller" must not match.
 */
export const ASIN_PATTERN = /^(?:B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$/i;

export function isAsin(term: string): boolean {
  return ASIN_PATTERN.test(term.trim());
}
