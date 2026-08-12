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
            className={`rounded-md border px-3 py-2 text-sm shadow-lg ${
              t.tone === "success"
                ? "border-emerald-900 bg-emerald-950 text-emerald-200"
                : "border-red-900 bg-red-950 text-red-200"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
