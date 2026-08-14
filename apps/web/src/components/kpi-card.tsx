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
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4 shadow-[0_4px_12px_rgba(0,0,0,0.35)] transition-all hover:border-sky-800 hover:shadow-[0_8px_24px_rgba(0,0,0,0.45),0_0_20px_rgba(124,58,237,0.12)]">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
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
    </div>
  );
}
