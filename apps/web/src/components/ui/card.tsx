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
  return (
    <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-5 py-3.5">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs font-normal text-zinc-500">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 py-4 ${className}`} {...props} />;
}
