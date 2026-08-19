import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ReauthDialog } from "./reauth-dialog";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  redeem: vi.fn(),
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
  useRedeemLoginLink: () => ({
    mutate: mocks.redeem,
    isPending: false,
    error: null,
  }),
}));

function setStandalone(standalone: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: standalone && query === "(display-mode: standalone)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

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
    mocks.redeem.mockReset();
    mocks.redeem.mockImplementation(
      (_link: string, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    mocks.isSuccess = false;
    mocks.devLoginUrl = undefined;
    setStandalone(false);
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

  it("sends the caller's return path as next when it carries a pending action", () => {
    render(
      <ReauthDialog open={true} onClose={() => {}} next="/changes?apply=52" />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    expect(mocks.login).toHaveBeenCalledWith({
      email: "owner@example.com",
      next: "/changes?apply=52",
    });
  });

  it("resumes the blocked action after a pasted link signs in", () => {
    mocks.isSuccess = true;
    setStandalone(true);
    const onClose = vi.fn();
    const onReauthenticated = vi.fn();
    render(
      <ReauthDialog
        open={true}
        onClose={onClose}
        onReauthenticated={onReauthenticated}
      />,
    );

    fireEvent.change(
      screen.getByLabelText("Paste the sign-in link from your email"),
      { target: { value: "https://app.test/api/session/verify?token=abc" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in with link" }));

    expect(onClose).toHaveBeenCalled();
    expect(onReauthenticated).toHaveBeenCalled();
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

  it("takes the link back by paste in the installed app", () => {
    mocks.isSuccess = true;
    setStandalone(true);
    render(<ReauthDialog open={true} onClose={() => {}} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      /Copy the link and paste it below/,
    );
    expect(
      screen.getByLabelText("Paste the sign-in link from your email"),
    ).toBeInTheDocument();
  });

  it("keeps the paste fallback out of the browser flow", () => {
    mocks.isSuccess = true;
    render(<ReauthDialog open={true} onClose={() => {}} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      /brings you right back to this page/,
    );
    expect(
      screen.queryByLabelText("Paste the sign-in link from your email"),
    ).toBeNull();
  });

  it("renders nothing while closed", () => {
    render(<ReauthDialog open={false} onClose={() => {}} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
