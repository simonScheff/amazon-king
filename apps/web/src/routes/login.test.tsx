import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./login";

const fetchMock = vi.fn<typeof fetch>();

function renderLogin() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<LoginPage />, { wrapper });
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    window.history.replaceState({}, "", "/login");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("explains an invalid magic link and allows a new request", () => {
    window.history.replaceState({}, "", "/login?error=invalid_token");
    renderLogin();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "invalid, expired, or already used",
    );
    expect(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    ).toBeEnabled();
  });

  it("allows another request after showing the sent state", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    renderLogin();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("owner@example.com"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send another link" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("owner@example.com");
    expect(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    ).toBeEnabled();
  });

  it("shows the local redirect URL when development email is unavailable", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          devLoginUrl:
            "http://localhost:3000/api/session/verify?token=single-use",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    renderLogin();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    const link = await screen.findByRole("link", { name: "Continue sign-in" });
    expect(link).toHaveAttribute(
      "href",
      "http://localhost:3000/api/session/verify?token=single-use",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Email delivery is not configured",
    );
  });
});
