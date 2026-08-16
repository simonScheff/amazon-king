import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ReauthDialog } from "./reauth-dialog";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  isSuccess: false,
  devLoginUrl: undefined as string | undefined,
}));

vi.mock("../api/endpoints", () => ({
  useSession: () => ({ data: { email: "owner@example.com" } }),
  useLogin: () => ({
    mutate: mocks.login,
    isPending: false,
    isSuccess: mocks.isSuccess,
    error: null,
    data: mocks.isSuccess
      ? { ok: true, devLoginUrl: mocks.devLoginUrl }
      : undefined,
  }),
}));

// jsdom lacks HTMLDialogElement.showModal/close; render a minimal stand-in.
vi.mock("./ui/dialog", () => ({
  Dialog: (props: {
    open: boolean;
    title: string;
    children: ReactNode;
    confirmLabel?: string;
    onConfirm?: () => void;
    onClose: () => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        {props.children}
        {props.onConfirm && (
          <button onClick={props.onConfirm}>
            {props.confirmLabel ?? "Confirm"}
          </button>
        )}
        <button onClick={props.onClose}>Cancel</button>
      </div>
    ) : null,
}));

describe("ReauthDialog", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.login.mockReset();
    mocks.isSuccess = false;
    mocks.devLoginUrl = undefined;
  });

  it("explains the recent sign-in requirement with the session email", () => {
    render(<ReauthDialog open={true} onClose={() => {}} />);

    expect(screen.getByRole("dialog")).toHaveTextContent(
      /needs a sign-in from the last 15 minutes/,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("owner@example.com");
  });

  it("sends a magic link carrying the current path as next", () => {
    render(<ReauthDialog open={true} onClose={() => {}} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    expect(mocks.login).toHaveBeenCalledWith({
      email: "owner@example.com",
      next: window.location.pathname + window.location.search,
    });
  });

  it("shows the dev sign-in link when email delivery is not configured", () => {
    mocks.isSuccess = true;
    mocks.devLoginUrl = "http://localhost:3000/api/session/verify?token=abc";
    render(<ReauthDialog open={true} onClose={() => {}} />);

    expect(
      screen.getByRole("link", { name: "Continue sign-in" }),
    ).toHaveAttribute("href", mocks.devLoginUrl);
    expect(
      screen.queryByRole("button", { name: "Email me a sign-in link" }),
    ).toBeNull();
  });

  it("points to the inbox once the link is sent", () => {
    mocks.isSuccess = true;
    render(<ReauthDialog open={true} onClose={() => {}} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      /Check your inbox.*owner@example\.com/,
    );
  });

  it("renders nothing while closed", () => {
    render(<ReauthDialog open={false} onClose={() => {}} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
