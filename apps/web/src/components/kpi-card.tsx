import type { ReactNode } from "react";

interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** When true, show an "economics missing" placeholder instead of a value. */
  missing?: boolean;
  /** Series color shown next to the label when the card toggles a chart line. */
  swatch?: string;
  /** Whether the linked chart series is currently visible. */
  active?: boolean;
  /** When set, the card becomes a toggle button for a chart series. */
  onToggle?: () => void;
}

export function KpiCard({
  label,
  value,
  hint,
  missing = false,
  swatch,
  active = true,
  onToggle,
}: KpiCardProps) {
  const className = [
    "rounded-xl border px-5 py-4 text-left shadow-[0_4px_12px_rgba(0,0,0,0.35)] transition-all",
    active
      ? "border-zinc-800 bg-zinc-900 hover:border-sky-800 hover:shadow-[0_8px_24px_rgba(0,0,0,0.45),0_0_20px_rgba(124,58,237,0.12)]"
      : "border-zinc-800/60 bg-zinc-900/50 opacity-55 hover:border-zinc-700 hover:opacity-80",
    onToggle ? "cursor-pointer" : "",
  ].join(" ");

  const body = (
    <>
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {swatch ? (
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: active ? swatch : "#52525b" }}
          />
        ) : null}
        {label}
      </p>
      {missing ? (
        <p className="mt-1.5 text-sm text-zinc-500">
          — <span className="text-xs">economics missing</span>
        </p>
      ) : (
        <p className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-100">
          {value}
        </p>
      )}
      {hint ? <p className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
    </>
  );

  if (onToggle) {
    return (
      <button
        type="button"
        aria-pressed={active}
        title={
          active ? `Hide ${label} on the chart` : `Show ${label} on the chart`
        }
        onClick={onToggle}
        className={className}
      >
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}
