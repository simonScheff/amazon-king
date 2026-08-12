import type { ReactNode } from "react";

interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** When true, show an "economics missing" placeholder instead of a value. */
  missing?: boolean;
}

export function KpiCard({ label, value, hint, missing = false }: KpiCardProps) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      {missing ? (
        <p className="mt-1 text-sm text-zinc-500">
          — <span className="text-xs">economics missing</span>
        </p>
      ) : (
        <p className="mt-1 text-xl font-semibold text-zinc-100">{value}</p>
      )}
      {hint ? <p className="mt-0.5 text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}
