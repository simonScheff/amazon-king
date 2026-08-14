import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallBanner } from "./install-banner";

function setUserAgent(ua: string, platform = "") {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: ua,
  });
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

function setStandalone(standalone: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: standalone && query === "(display-mode: standalone)",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

const CHROME_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

beforeEach(() => {
  setUserAgent(CHROME_ANDROID_UA);
  setStandalone(false);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("InstallBanner", () => {
  it("stays hidden until the browser fires beforeinstallprompt", () => {
    const { container } = render(<InstallBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a native install when beforeinstallprompt fires", async () => {
    render(<InstallBanner />);

    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event("beforeinstallprompt");
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    fireEvent(window, event);

    const installButton = await screen.findByRole("button", {
      name: "Install",
    });
    fireEvent.click(installButton);
    expect(prompt).toHaveBeenCalled();
  });

  it("shows manual Add to Home Screen instructions on iOS Safari", () => {
    setUserAgent(IOS_SAFARI_UA, "iPhone");
    render(<InstallBanner />);

    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Install" }),
    ).not.toBeInTheDocument();
  });

  it("stays hidden when the app is already running standalone", () => {
    setStandalone(true);
    const { container } = render(<InstallBanner />);

    fireEvent(window, new Event("beforeinstallprompt"));
    expect(container).toBeEmptyDOMElement();
  });

  it("stays dismissed across renders once closed", () => {
    setUserAgent(IOS_SAFARI_UA, "iPhone");
    const { unmount } = render(<InstallBanner />);

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss install prompt" }),
    );
    expect(screen.queryByText(/Add to Home Screen/)).not.toBeInTheDocument();

    unmount();
    const { container } = render(<InstallBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
