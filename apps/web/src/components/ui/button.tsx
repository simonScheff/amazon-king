import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-sky-600 text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.25),0_4px_14px_rgba(109,59,215,0.35)] hover:bg-sky-500 hover:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.25),0_4px_22px_rgba(139,92,246,0.5)] focus-visible:outline-sky-400 active:scale-[0.98] disabled:bg-sky-900 disabled:text-zinc-400 disabled:shadow-none",
  secondary:
    "bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:border-zinc-600 border border-zinc-700 focus-visible:outline-sky-400 active:scale-[0.98] disabled:text-zinc-500",
  danger:
    "bg-red-700 text-white shadow-[0_4px_14px_rgba(186,26,26,0.35)] hover:bg-red-600 focus-visible:outline-red-400 active:scale-[0.98] disabled:bg-red-950 disabled:text-zinc-500 disabled:shadow-none",
  ghost:
    "bg-transparent text-zinc-300 hover:bg-zinc-800 focus-visible:outline-zinc-400 disabled:text-zinc-600",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "secondary", size = "md", className = "", ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
        {...props}
      />
    );
  },
);
