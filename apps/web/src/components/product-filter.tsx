import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BookCoverThumb } from "./book-covers";
import { useBooks } from "../api/endpoints";

/** Book icon matching the sidebar nav icons. */
function BookIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </svg>
  );
}

/** Tooltip shown on hover next to the collapsed (icon-only) trigger. */
function IconTooltip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-100 shadow-lg md:group-hover:block"
    >
      {label}
    </span>
  );
}

/**
 * Global product filter: a multi-select of the owner's books stored in the
 * `books` URL search param (validated on the app layout route, retained across
 * navigation). Lives in the sidebar footer; the dropdown holds checkbox rows
 * (like the campaign wizard's markets step), stays open while toggling, and
 * opens upward — or to the right when the sidebar is collapsed to icons.
 */
export function ProductFilter({ collapsed = false }: { collapsed?: boolean }) {
  const search = useSearch({ strict: false }) as { books?: string[] };
  const selected = search.books ?? [];
  const books = useBooks();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function setSelected(next: string[]) {
    void navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        books: next.length > 0 ? next : undefined,
      }),
      replace: true,
    });
  }

  function toggleBook(bookId: string) {
    setSelected(
      selected.includes(bookId)
        ? selected.filter((id) => id !== bookId)
        : [...selected, bookId],
    );
  }

  const options = books.data ?? [];
  const single =
    selected.length === 1
      ? options.find((book) => book.id === selected[0])
      : undefined;
  const label =
    selected.length === 0
      ? "All products"
      : selected.length === 1
        ? (single?.title ?? selected[0])
        : `${selected.length} products`;

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Filter by product: ${label}`}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={books.isPending}
        title={label}
        onClick={() => setOpen((current) => !current)}
        className={`group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600 ${
          collapsed ? "md:justify-center md:px-0" : ""
        }`}
      >
        <BookIcon />
        <span
          className={`min-w-0 flex-1 truncate text-left ${collapsed ? "md:hidden" : ""}`}
        >
          {label}
        </span>
        {collapsed && <IconTooltip label={`Products: ${label}`} />}
        {collapsed && selected.length > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 hidden h-1.5 w-1.5 rounded-full bg-sky-400 md:block"
          />
        )}
      </button>
      {open && !books.isPending ? (
        <ul
          role="group"
          aria-label="Products"
          className={`absolute bottom-full left-0 z-50 mb-1 max-h-80 w-full overflow-y-auto overflow-x-hidden rounded-lg border border-zinc-700 bg-zinc-950 py-1 shadow-lg shadow-black/40 ${
            collapsed ? "md:bottom-0 md:mb-0 md:left-full md:ml-2 md:w-64" : ""
          }`}
        >
          <li>
            <label className="flex w-full cursor-pointer items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800">
              <input
                type="checkbox"
                className="h-4 w-4 accent-sky-600"
                checked={selected.length === 0}
                onChange={() => setSelected([])}
                aria-label="All products"
              />
              <span>All products</span>
            </label>
          </li>
          {options.map((book) => (
            <li key={book.id}>
              <label
                title={`${book.title} (${book.format})`}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-sky-600"
                  checked={selected.includes(book.id)}
                  onChange={() => toggleBook(book.id)}
                />
                <BookCoverThumb
                  title={book.title}
                  coverImageUrl={book.coverImageUrl}
                  size="sm"
                  decorative
                />
                <span className="min-w-0 flex-1 truncate">{book.title}</span>
                <span className="shrink-0 text-xs text-zinc-500">
                  ({book.format})
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
