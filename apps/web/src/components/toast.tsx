import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

interface Toast {
  id: number;
  message: string;
  tone: "success" | "error";
}

const ToastContext = createContext<
  (message: string, tone?: Toast["tone"]) => void
>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback(
    (message: string, tone: Toast["tone"] = "success") => {
      const id = nextId++;
      setToasts((ts) => [...ts, { id, message, tone }]);
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000);
    },
    [],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-lg border border-zinc-800 border-l-4 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 shadow-[0_8px_24px_rgba(0,0,0,0.5)] ${
              t.tone === "success" ? "border-l-emerald-500" : "border-l-red-700"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
