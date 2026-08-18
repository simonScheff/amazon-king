const SIZE_CLASS = {
  sm: "h-8 w-6",
  md: "h-10 w-7",
} as const;

export type CoverBook = {
  id: string;
  title: string;
  coverImageUrl?: string | null;
};

/** Small book-cover thumbnail; a muted placeholder when the URL is missing. */
export function BookCoverThumb({
  title,
  coverImageUrl,
  size = "md",
  className = "",
  decorative = false,
}: {
  title: string;
  coverImageUrl?: string | null;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
  /** Hide from the accessibility tree when the title is already nearby. */
  decorative?: boolean;
}) {
  const classes = `${SIZE_CLASS[size]} shrink-0 rounded border border-zinc-800 ${className}`;
  if (!coverImageUrl) {
    return (
      <span
        className={`${classes} bg-zinc-900`}
        title={title}
        aria-hidden="true"
      />
    );
  }
  return (
    <img
      src={coverImageUrl}
      alt={decorative ? "" : `${title} cover`}
      title={title}
      aria-hidden={decorative ? true : undefined}
      className={`${classes} bg-zinc-900 object-cover`}
    />
  );
}

/**
 * One or more covers for the catalog books linked to a campaign or search
 * term. Unknown ids (books still loading) render as placeholders.
 */
export function BookCoverStack({
  bookIds,
  books,
  size = "md",
}: {
  bookIds: string[];
  books: CoverBook[] | undefined;
  size?: keyof typeof SIZE_CLASS;
}) {
  if (bookIds.length === 0) return null;
  const byId = new Map((books ?? []).map((book) => [book.id, book]));
  const resolved = bookIds.map(
    (id) => byId.get(id) ?? { id, title: "Book", coverImageUrl: null },
  );
  const shown = resolved.slice(0, 3);
  const extra = resolved.length - shown.length;
  return (
    <span className="inline-flex items-center self-start">
      {shown.map((book, index) => (
        <BookCoverThumb
          key={book.id}
          title={book.title}
          coverImageUrl={book.coverImageUrl}
          size={size}
          className={index > 0 ? "-ml-1.5 ring-2 ring-zinc-950" : ""}
        />
      ))}
      {extra > 0 ? (
        <span className="ml-1 text-[10px] text-zinc-500">+{extra}</span>
      ) : null}
    </span>
  );
}
