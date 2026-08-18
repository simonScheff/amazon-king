import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { PasteLoginLink } from "./paste-login-link";

const mocks = vi.hoisted(() => ({
  redeem: vi.fn(),
  isPending: false,
  error: null as ApiError | null,
}));

vi.mock("../api/endpoints", () => ({
  useRedeemLoginLink: () => ({
    mutate: mocks.redeem,
    isPending: mocks.isPending,
    error: mocks.error,
  }),
}));

beforeEach(() => {
  mocks.redeem.mockReset();
  mocks.isPending = false;
  mocks.error = null;
});

afterEach(cleanup);

describe("PasteLoginLink", () => {
  it("redeems the pasted link and reports the new session", () => {
    const onSignedIn = vi.fn();
    mocks.redeem.mockImplementation(
      (_link: string, options: { onSuccess: () => void }) =>
        options.onSuccess(),
    );
    render(<PasteLoginLink onSignedIn={onSignedIn} />);

    fireEvent.change(
      screen.getByLabelText("Paste the sign-in link from your email"),
      { target: { value: "https://ads.example.com/api/session/verify?t=x" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in with link" }));

    expect(mocks.redeem.mock.calls[0]?.[0]).toBe(
      "https://ads.example.com/api/session/verify?t=x",
    );
    expect(onSignedIn).toHaveBeenCalledOnce();
  });

  it("shows why a link was rejected", () => {
    mocks.error = new ApiError(401, "This sign-in link is already used.");
    render(<PasteLoginLink />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This sign-in link is already used.",
    );
  });
});
