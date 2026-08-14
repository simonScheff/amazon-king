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
      className="m-auto w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 shadow-[0_24px_48px_rgba(0,0,0,0.6)] backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="border-b border-zinc-800 px-5 py-4">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <div className="px-5 py-4 text-sm text-zinc-300">{children}</div>
      <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-4">
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
