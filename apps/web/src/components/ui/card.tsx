import type { HTMLAttributes, ReactNode } from "react";

export function Card({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-zinc-800 bg-zinc-900 shadow-[0_4px_12px_rgba(0,0,0,0.35)] ${className}`}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  action,
  description,
}: {
  title: ReactNode;
  action?: ReactNode;
  description?: ReactNode;
}) {
  // Stacked on narrow screens so a long title/description never gets crushed
  // beside the action; selects inside the action go full-width there.
  return (
    <div className="flex flex-col gap-3 border-b border-zinc-800 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs font-normal text-zinc-500">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="shrink-0 max-sm:w-full max-sm:[&_select]:w-full">
          {action}
        </div>
      ) : null}
    </div>
  );
}

export function CardBody({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 py-4 ${className}`} {...props} />;
}
