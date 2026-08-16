import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { ApiError } from "../api/client";
import { useDashboardSummary, useLogout, useSession } from "../api/endpoints";
import { ToastProvider, useToast } from "./toast";
import { InstallBanner } from "./install-banner";
import { Loading } from "./states";

type IconProps = { className?: string };

function makeIcon(path: React.ReactNode) {
  return function Icon({ className }: IconProps) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ?? "h-5 w-5 shrink-0"}
      >
        {path}
      </svg>
    );
  };
}

const OverviewIcon = makeIcon(
  <>
    <rect x="3" y="3" width="8" height="10" rx="1.5" />
    <rect x="13" y="3" width="8" height="6" rx="1.5" />
    <rect x="13" y="11" width="8" height="10" rx="1.5" />
    <rect x="3" y="15" width="8" height="6" rx="1.5" />
  </>,
);
const RecommendationsIcon = makeIcon(
  <>
    <path d="M9 18h6" />
    <path d="M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.5 10.9c.7.6 1 1.4 1 2.1h5c0-.7.3-1.5 1-2.1A6 6 0 0 0 12 3Z" />
  </>,
);
const CampaignsIcon = makeIcon(
  <>
    <path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Z" />
    <path d="M14 8.5a4.5 4.5 0 0 1 0 7" />
    <path d="M17 6a8.5 8.5 0 0 1 0 12" />
  </>,
);
const SearchTermsIcon = makeIcon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4-4" />
  </>,
);
const ChangesIcon = makeIcon(
  <>
    <path d="M17 3h4v4" />
    <path d="M21 3 9 15" />
    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
  </>,
);
const ConnectIcon = makeIcon(
  <>
    <path d="M9 17H7a5 5 0 0 1 0-10h2" />
    <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
    <path d="M8 12h8" />
  </>,
);
const SettingsIcon = makeIcon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
  </>,
);
const SignOutIcon = makeIcon(
  <>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </>,
);

const navItems = [
  { to: "/", label: "Overview", Icon: OverviewIcon },
  {
    to: "/recommendations",
    label: "Recommendations",
    Icon: RecommendationsIcon,
  },
  { to: "/campaigns", label: "Campaigns", Icon: CampaignsIcon },
  { to: "/search-terms", label: "Search terms", Icon: SearchTermsIcon },
  { to: "/changes", label: "Change center", Icon: ChangesIcon },
  { to: "/connect", label: "Connection", Icon: ConnectIcon },
  { to: "/settings", label: "Settings", Icon: SettingsIcon },
] as const;

function KillSwitchBanner() {
  // days value is irrelevant for the kill-switch flag; reuse the summary cache.
  const { data } = useDashboardSummary(7);
  if (!data?.writesDisabled) return null;
  return (
    <div
      role="alert"
      className="border-b border-red-900 bg-red-950 px-4 py-2.5 text-center text-sm font-medium text-red-200"
    >
      Kill switch active — all Amazon writes are disabled.
    </div>
  );
}

/** Tooltip shown on hover next to collapsed (icon-only) sidebar items. */
function IconTooltip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-100 shadow-lg md:group-hover:block"
    >
      {label}
    </span>
  );
}

function Sidebar({
  collapsed,
  onToggleCollapse,
  onNavigate,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onNavigate?: () => void;
}) {
  const logout = useLogout();
  const navigate = useNavigate();
  const toast = useToast();
  const isCollapsed = collapsed ?? false;
  return (
    <nav
      aria-label="Main"
      className={`flex h-full flex-col gap-1 p-4 ${isCollapsed ? "md:items-center md:p-3" : ""}`}
    >
      <div
        className={`flex items-center gap-2.5 px-2 pb-4 pt-1 ${
          isCollapsed ? "md:justify-center md:px-0" : ""
        }`}
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-sm font-bold text-white shadow-sm"
        >
          AK
        </span>
        <p
          className={`text-base font-bold tracking-tight text-zinc-100 ${isCollapsed ? "md:hidden" : ""}`}
        >
          Amazon King
        </p>
      </div>
      {navItems.map(({ to, label, Icon }) => (
        <Link
          key={to}
          to={to}
          onClick={onNavigate}
          aria-label={isCollapsed ? label : undefined}
          activeOptions={{ exact: to === "/" }}
          className={`group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 ${
            isCollapsed ? "md:justify-center md:px-0" : ""
          }`}
          activeProps={{ className: "bg-sky-950 text-sky-300" }}
        >
          <Icon />
          <span className={isCollapsed ? "md:hidden" : undefined}>{label}</span>
          {isCollapsed && <IconTooltip label={label} />}
        </Link>
      ))}
      <div
        aria-hidden="true"
        className="my-2 w-full border-t border-zinc-800"
      />
      <button
        type="button"
        aria-label={isCollapsed ? "Sign out" : undefined}
        className={`group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600 ${
          isCollapsed ? "md:justify-center md:px-0" : ""
        }`}
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
        <SignOutIcon />
        <span className={isCollapsed ? "md:hidden" : undefined}>
          {logout.isPending ? "Signing out…" : "Sign out"}
        </span>
        {isCollapsed && !logout.isPending && <IconTooltip label="Sign out" />}
      </button>
      {onToggleCollapse && (
        <>
          <div aria-hidden="true" className="flex-1" />
          <button
            type="button"
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!isCollapsed}
            onClick={onToggleCollapse}
            className={`group relative hidden w-full items-center gap-3 rounded-lg px-3 py-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 md:flex ${
              isCollapsed ? "md:justify-center md:px-0" : ""
            }`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-5 w-5 shrink-0 transition-transform ${isCollapsed ? "rotate-180" : ""}`}
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            <span
              className={`text-sm font-medium ${isCollapsed ? "md:hidden" : ""}`}
            >
              Collapse
            </span>
            {isCollapsed && <IconTooltip label="Expand sidebar" />}
          </button>
        </>
      )}
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

const COLLAPSED_STORAGE_KEY = "amazon-king.sidebar-collapsed";

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1",
  );
  const toggleSidebar = () =>
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
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
              className="fixed left-3 top-3 z-40 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm shadow-sm md:hidden"
            >
              ☰
            </button>
            <aside
              className={`fixed inset-y-0 left-0 z-30 border-r border-zinc-800 bg-zinc-900/95 backdrop-blur transition-[transform,width] md:sticky md:top-0 md:h-screen md:translate-x-0 ${
                navOpen ? "translate-x-0" : "-translate-x-full"
              } w-60 ${sidebarCollapsed ? "md:w-16" : "md:w-60"}`}
            >
              <Sidebar
                collapsed={sidebarCollapsed}
                onToggleCollapse={toggleSidebar}
                onNavigate={() => setNavOpen(false)}
              />
            </aside>
            <main className="min-w-0 flex-1 px-4 py-8 md:px-10">
              <div className="mx-auto w-full max-w-[1440px]">
                <div className="h-8 md:hidden" />
                <Outlet />
              </div>
            </main>
          </div>
          <InstallBanner />
        </div>
      </SessionGate>
    </ToastProvider>
  );
}
