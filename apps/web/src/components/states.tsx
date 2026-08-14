import type { ReactNode } from "react";
import { ApiError } from "../api/client";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-2.5 px-5 py-8 text-sm text-zinc-500"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-[spin_0.8s_linear_infinite] rounded-full border-2 border-zinc-700 border-t-sky-600"
      />
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
      className="mx-5 my-4 rounded-lg border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-300"
    >
      {message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="px-5 py-8 text-center text-sm text-zinc-500">{children}</p>
  );
}
