import { cleanup, render, screen } from "@testing-library/react";
import { Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  // jsdom does not implement scrollTo; the router calls it on navigation.
  window.scrollTo = () => {};
});

// Render the real route tree with stub components so navigation can be
// exercised without a session or API.
vi.mock("./components/layout", () => ({
  AppLayout: () => (
    <div>
      shell
      <Outlet />
    </div>
  ),
}));
vi.mock("./routes/overview", () => ({
  OverviewPage: () => <div>overview page</div>,
}));
vi.mock("./routes/campaigns", () => ({
  CampaignsPage: () => <div>campaigns page</div>,
}));
vi.mock("./routes/search-terms", () => ({
  SearchTermsPage: () => <div>search terms page</div>,
}));

import { router } from "./router";

/** Validated search of the currently matched leaf route. */
function leafSearch(): Record<string, unknown> {
  const match = router.state.matches.at(-1);
  return (match?.search ?? {}) as Record<string, unknown>;
}

describe("global books search param", () => {
  afterEach(cleanup);

  it("parses ?books=3,7 once at the layout route and retains it across child navigation", async () => {
    render(<RouterProvider router={router} />);

    // Raw URL form is comma-separated text (validated type is string[], hence
    // the cast — this simulates loading /?books=3,%207,, directly).
    await router.navigate({
      to: "/",
      search: { books: "3, 7,," } as never,
    });
    await screen.findByText("overview page");
    expect(leafSearch()).toEqual({ books: ["3", "7"] });
    expect(router.state.location.href).toBe("/?books=3%2C7");

    // Plain navigation to a child route (no search specified) retains the
    // inherited layout-level param, even though the leaf validators never
    // mention it.
    await router.navigate({ to: "/campaigns" });
    await screen.findByText("campaigns page");
    expect(leafSearch()).toEqual({ books: ["3", "7"] });

    await router.navigate({ to: "/search-terms" });
    await screen.findByText("search terms page");
    expect(leafSearch()).toEqual({ books: ["3", "7"] });
    expect(router.state.location.href).toBe("/search-terms?books=3%2C7");

    // A functional search update that spreads prev keeps the filter while
    // changing another param, and the URL stays in the ?books=3,7 form.
    await router.navigate({
      to: "/search-terms",
      search: (prev) => ({ ...prev, country: "DE" }),
      replace: true,
    });
    expect(leafSearch()).toEqual({ books: ["3", "7"], country: "DE" });
    expect(router.state.location.href).toBe(
      "/search-terms?books=3%2C7&country=DE",
    );

    // Clearing the filter drops the param entirely.
    await router.navigate({
      to: "/search-terms",
      search: (prev) => ({ ...prev, books: undefined }),
      replace: true,
    });
    expect(leafSearch()).toEqual({ country: "DE" });
    expect(router.state.location.href).toBe("/search-terms?country=DE");
  });
});
