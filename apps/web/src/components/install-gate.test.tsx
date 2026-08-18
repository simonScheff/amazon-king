import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallGate } from "./install-gate";

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function setUserAgent(ua: string, platform = "", maxTouchPoints = 0) {
  for (const [key, value] of Object.entries({ userAgent: ua, platform })) {
    Object.defineProperty(window.navigator, key, {
      configurable: true,
      value,
    });
  }
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints,
  });
}

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

function fireInstallPrompt(prompt = vi.fn().mockResolvedValue(undefined)) {
  const event = new Event("beforeinstallprompt");
  Object.assign(event, {
    prompt,
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  fireEvent(window, event);
  return prompt;
}

beforeEach(() => {
  setUserAgent(DESKTOP_UA, "MacIntel");
  setStandalone(false);
});

afterEach(cleanup);

describe("InstallGate", () => {
  it("lets desktop browsers through", () => {
    render(
      <InstallGate>
        <p>dashboard</p>
      </InstallGate>,
    );

    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("blocks a phone browser with Add to Home Screen instructions", () => {
    setUserAgent(IPHONE_SAFARI_UA, "iPhone", 5);
    render(
      <InstallGate>
        <p>dashboard</p>
      </InstallGate>,
    );

    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
  });

  it("tells other iOS browsers to switch to Safari", () => {
    setUserAgent(`${IPHONE_SAFARI_UA} CriOS/126.0.0.0`, "iPhone", 5);
    render(
      <InstallGate>
        <p>dashboard</p>
      </InstallGate>,
    );

    expect(screen.getByText("Safari")).toBeInTheDocument();
  });

  it("offers the native install prompt when the browser can install", async () => {
    setUserAgent(ANDROID_CHROME_UA, "Linux armv8l", 5);
    render(
      <InstallGate>
        <p>dashboard</p>
      </InstallGate>,
    );

    expect(
      screen.queryByRole("button", { name: "Install" }),
    ).not.toBeInTheDocument();

    const prompt = fireInstallPrompt();
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));

    expect(prompt).toHaveBeenCalledOnce();
  });

  it("points at the home screen once the app is installed", () => {
    setUserAgent(ANDROID_CHROME_UA, "Linux armv8l", 5);
    render(
      <InstallGate>
        <p>dashboard</p>
      </InstallGate>,
    );

    fireEvent(window, new Event("appinstalled"));

    expect(screen.getByText("Amazon King is installed")).toBeInTheDocument();
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
  });

  it("lets the installed app through", () => {
    setUserAgent(IPHONE_SAFARI_UA, "iPhone", 5);
    setStandalone(true);
    render(
      <InstallGate>
        <p>dashboard</p>
      </InstallGate>,
    );

    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("offers no way to dismiss the gate", () => {
    setUserAgent(IPHONE_SAFARI_UA, "iPhone", 5);
    render(
      <InstallGate>
        <p>dashboard</p>
      </InstallGate>,
    );

    // The dev-only bypass is the single button, and never ships to production.
    expect(
      screen
        .queryAllByRole("button")
        .filter((button) => !/dev only/.test(button.textContent ?? "")),
    ).toHaveLength(0);
  });
});
