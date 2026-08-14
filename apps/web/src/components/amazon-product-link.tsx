import { amazonProductUrl, isAsin } from "../lib/asin";

/**
 * "View on Amazon" link for ASIN-shaped shopper terms; renders nothing for
 * plain text queries. Used wherever a search term is displayed so a product
 * term can be opened on the retail site of its marketplace.
 */
export function AmazonProductLink({
  term,
  countryCode,
  className = "",
}: {
  term: string;
  countryCode?: string;
  className?: string;
}) {
  if (!isAsin(term)) return null;
  return (
    <a
      href={amazonProductUrl(term, countryCode)}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-sky-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${className}`}
    >
      View on Amazon <span aria-hidden="true">↗</span>
    </a>
  );
}
