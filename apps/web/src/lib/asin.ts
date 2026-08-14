/**
 * Search-term reports put ASINs in the same column as text queries when an
 * auto or product target matched a product detail page; Amazon provides no
 * explicit flag. ASINs are 10 uppercase alphanumeric characters and KDP
 * products always start with "B0", so the shape is a reliable heuristic.
 */
const ASIN_PATTERN = /^B0[A-Z0-9]{8}$/;

export function isAsin(term: string): boolean {
  return ASIN_PATTERN.test(term.trim().toUpperCase());
}

/** Retail domains by profile country; unknown countries fall back to .com. */
const marketplaceDomains: Readonly<Record<string, string>> = {
  US: "amazon.com",
  CA: "amazon.ca",
  MX: "amazon.com.mx",
  BR: "amazon.com.br",
  GB: "amazon.co.uk",
  // Amazon profile data can say UK instead of GB (see flag aliases).
  UK: "amazon.co.uk",
  DE: "amazon.de",
  FR: "amazon.fr",
  IT: "amazon.it",
  ES: "amazon.es",
  NL: "amazon.nl",
  SE: "amazon.se",
  PL: "amazon.pl",
  BE: "amazon.com.be",
  JP: "amazon.co.jp",
  AU: "amazon.com.au",
  IN: "amazon.in",
  SG: "amazon.sg",
  AE: "amazon.ae",
  SA: "amazon.sa",
  EG: "amazon.eg",
  TR: "amazon.com.tr",
};

export function amazonProductUrl(asin: string, countryCode?: string): string {
  const domain =
    marketplaceDomains[countryCode?.toUpperCase() ?? ""] ?? "amazon.com";
  return `https://www.${domain}/dp/${asin.trim().toUpperCase()}`;
}
