/**
 * Search-term reports put ASINs in the same column as text queries when an
 * auto or product target matched a product detail page; Amazon provides no
 * explicit flag. ASINs are 10 uppercase alphanumeric characters and KDP
 * products always start with "B0", so the shape is a reliable heuristic.
 */
export const ASIN_PATTERN = /^B0[A-Z0-9]{8}$/i;

export function isAsin(term: string): boolean {
  return ASIN_PATTERN.test(term.trim());
}
