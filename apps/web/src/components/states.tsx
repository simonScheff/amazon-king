import type { ReactNode } from "react";
import { ApiError } from "../api/client";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="px-4 py-6 text-sm text-zinc-500">
      {label}
    </p>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError
      ? `${error.message} (HTTP ${error.status})`
      : error instanceof Error
        ? error.message
        : "Something went wrong";
  return (
    <div
      role="alert"
      className="mx-4 my-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300"
    >
      {message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-zinc-500">{children}</p>;
}
