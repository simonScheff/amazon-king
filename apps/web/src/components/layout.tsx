import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { ApiError } from "../api/client";
import { useDashboardSummary, useLogout, useSession } from "../api/endpoints";
import { ToastProvider, useToast } from "./toast";
import { Loading } from "./states";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/recommendations", label: "Recommendations" },
  { to: "/campaigns", label: "Campaigns" },
  { to: "/changes", label: "Change center" },
  { to: "/connect", label: "Connection" },
  { to: "/settings", label: "Settings" },
] as const;

function KillSwitchBanner() {
  // days value is irrelevant for the kill-switch flag; reuse the summary cache.
  const { data } = useDashboardSummary(7);
  if (!data?.writesDisabled) return null;
  return (
    <div
      role="alert"
      className="border-b border-red-900 bg-red-950 px-4 py-2 text-center text-sm font-medium text-red-200"
    >
      Kill switch active — all Amazon writes are disabled.
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const logout = useLogout();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 p-3">
      <p className="px-2 pb-3 text-sm font-bold text-zinc-100">Amazon King</p>
      {navItems.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          activeOptions={{ exact: item.to === "/" }}
          className="rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          activeProps={{ className: "bg-zinc-800 text-zinc-100" }}
        >
          {item.label}
        </Link>
      ))}
      <div aria-hidden="true" className="my-1 border-t border-zinc-800" />
      <button
        type="button"
        className="w-full rounded-md px-2 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:cursor-not-allowed disabled:text-zinc-600"
        onClick={() =>
          logout.mutate(undefined, {
            onSuccess: () => navigate({ to: "/login" }),
            onError: (error) => {
              if (error instanceof ApiError && error.status === 401) {
                void navigate({ to: "/login" });
                return;
              }
              toast(`Sign out failed: ${error.message}`, "error");
            },
          })
        }
        disabled={logout.isPending}
      >
        {logout.isPending ? "Signing out…" : "Sign out"}
      </button>
    </nav>
  );
}

/** Gate: redirects to /login when there is no valid session. */
function SessionGate({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (
      session.error instanceof ApiError &&
      session.error.status === 401 &&
      location.pathname !== "/login"
    ) {
      void navigate({ to: "/login" });
    }
  }, [session.error, location.pathname, navigate]);

  if (session.isPending) return <Loading label="Checking session…" />;
  if (session.error instanceof ApiError && session.error.status === 401) {
    return <Loading label="Redirecting to sign in…" />;
  }
  if (session.error) {
    return (
      <p role="alert" className="p-6 text-sm text-red-300">
        Could not load session: {session.error.message}
      </p>
    );
  }
  return <>{children}</>;
}

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <ToastProvider>
      <SessionGate>
        <div className="min-h-screen bg-zinc-950 text-zinc-200">
          <KillSwitchBanner />
          <div className="flex">
            <button
              type="button"
              aria-label="Toggle navigation"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((v) => !v)}
              className="fixed left-3 top-3 z-40 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm md:hidden"
            >
              ☰
            </button>
            <aside
              className={`fixed inset-y-0 left-0 z-30 w-52 border-r border-zinc-800 bg-zinc-950 transition-transform md:static md:translate-x-0 ${
                navOpen ? "translate-x-0" : "-translate-x-full"
              }`}
            >
              <Sidebar onNavigate={() => setNavOpen(false)} />
            </aside>
            <main className="min-w-0 flex-1 px-4 py-6 md:px-6">
              <div className="h-8 md:hidden" />
              <Outlet />
            </main>
          </div>
        </div>
      </SessionGate>
    </ToastProvider>
  );
}
