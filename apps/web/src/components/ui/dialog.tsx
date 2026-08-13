import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./button";

interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  confirmVariant?: "primary" | "danger";
  busy?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
}

/** Accessible modal built on the native <dialog> element. */
export function Dialog({
  open,
  title,
  children,
  confirmLabel,
  confirmVariant = "primary",
  busy = false,
  onConfirm,
  onClose,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/60"
    >
      <div className="border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="px-4 py-3 text-sm text-zinc-300">{children}</div>
      <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {onConfirm && (
          <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : (confirmLabel ?? "Confirm")}
          </Button>
        )}
      </div>
    </dialog>
  );
}
