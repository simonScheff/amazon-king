import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./layout";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  logoutMutate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    onClick,
    activeProps: _activeProps,
    activeOptions: _activeOptions,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
    activeProps?: unknown;
    activeOptions?: unknown;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={to}
      onClick={(event) => {
        // jsdom cannot navigate; the real Link intercepts the click too.
        event.preventDefault();
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
  Outlet: () => <div>page content</div>,
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => mocks.navigate,
}));

vi.mock("../api/endpoints", () => ({
  useSession: () => ({ isPending: false, error: null, data: {} }),
  useDashboardSummary: () => ({ data: { writesDisabled: false } }),
  useLogout: () => ({ mutate: mocks.logoutMutate, isPending: false }),
}));

vi.mock("./install-banner", () => ({ InstallBanner: () => null }));
vi.mock("./product-filter", () => ({ ProductFilter: () => null }));

/** The mobile drawer: off-canvas and untabbable unless open. */
function drawer(): HTMLElement {
  const aside = document.querySelector("aside");
  if (!aside) throw new Error("sidebar not rendered");
  return aside as HTMLElement;
}

/** The mobile-only overlay behind the open drawer. */
function backdrop(): HTMLElement | null {
  return document.querySelector<HTMLElement>("div.fixed.inset-0");
}

function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
}

describe("AppLayout mobile navigation", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("starts closed with the drawer off-canvas and hidden from focus", () => {
    render(<AppLayout />);

    expect(drawer().className).toContain("-translate-x-full");
    expect(drawer().className).toContain("invisible");
    expect(backdrop()).toBeNull();
  });

  it("opens on the menu button, which then yields to the in-drawer close button", () => {
    render(<AppLayout />);

    const opener = screen.getByRole("button", { name: "Open navigation" });
    openDrawer();

    expect(drawer().className).toContain("translate-x-0");
    expect(drawer().className).not.toContain("invisible");
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    // The opener sits where the drawer header is, so it is hidden while open
    // instead of overlapping the logo.
    expect(opener.className).toContain("hidden");
    // Closing is offered inside the drawer header instead.
    expect(drawer()).toContainElement(
      screen.getByRole("button", { name: "Close navigation" }),
    );
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("closes on a click outside the drawer", () => {
    render(<AppLayout />);
    openDrawer();

    const overlay = backdrop();
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as HTMLElement);

    expect(drawer().className).toContain("-translate-x-full");
    expect(backdrop()).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("closes on Escape, on the close button, and on navigating", () => {
    render(<AppLayout />);

    openDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(drawer().className).toContain("-translate-x-full");

    openDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(drawer().className).toContain("-translate-x-full");

    openDrawer();
    fireEvent.click(screen.getByRole("link", { name: "Campaigns" }));
    expect(drawer().className).toContain("-translate-x-full");
  });
});
