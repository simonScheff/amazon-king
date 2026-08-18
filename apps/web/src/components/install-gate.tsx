import { useEffect, useState, type ReactNode } from "react";
import {
  isIos,
  isIosSafari,
  isPhone,
  isStandalone,
  STANDALONE_QUERY,
  type BeforeInstallPromptEvent,
} from "../lib/install";
import { Button } from "./ui/button";

type InstallMethod = "native" | "ios-safari" | "ios-other" | "menu";

function instructions(method: InstallMethod): ReactNode {
  switch (method) {
    case "native":
      return "Tap Install below, then open Amazon King from your home screen.";
    case "ios-safari":
      return (
        <>
          Tap the <strong>Share</strong> button in Safari&rsquo;s toolbar,
          choose <strong>Add to Home Screen</strong>, then open Amazon King from
          your home screen.
        </>
      );
    case "ios-other":
      return (
        <>
          Open this page in <strong>Safari</strong>, tap <strong>Share</strong>{" "}
          &rarr; <strong>Add to Home Screen</strong>, then open Amazon King from
          your home screen.
        </>
      );
    case "menu":
      return (
        <>
          Open your browser menu and choose <strong>Install app</strong> or{" "}
          <strong>Add to Home screen</strong>, then open Amazon King from your
          home screen.
        </>
      );
  }
}

/**
 * Phones must use the installed home-screen app: the dashboard is dense and
 * the browser's address and toolbar cost too much of a phone viewport, so the
 * browser tab is a dead end rather than a degraded experience.
 *
 * This gate wraps the app routes only — `/login` stays reachable in the phone
 * browser on purpose. iOS gives an installed web app its own storage
 * container and copies Safari's cookies only at the moment it is added to the
 * home screen, so signing in first and installing second is the one order
 * that leaves the installed app with a session.
 */
export function InstallGate({ children }: { children: ReactNode }) {
  const [standalone, setStandalone] = useState(isStandalone);
  const [installed, setInstalled] = useState(false);
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [continueInBrowser, setContinueInBrowser] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(STANDALONE_QUERY);
    const syncDisplayMode = () => setStandalone(isStandalone());
    const onAppInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    };

    media.addEventListener("change", syncDisplayMode);
    window.addEventListener("appinstalled", onAppInstalled);
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => {
      media.removeEventListener("change", syncDisplayMode);
      window.removeEventListener("appinstalled", onAppInstalled);
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    };
  }, []);

  if (standalone || continueInBrowser || !isPhone()) return <>{children}</>;

  const install = () => {
    if (!prompt) return;
    void prompt.prompt().then(() => {
      void prompt.userChoice.finally(() => setPrompt(null));
    });
  };

  const method: InstallMethod = prompt
    ? "native"
    : isIosSafari()
      ? "ios-safari"
      : isIos()
        ? "ios-other"
        : "menu";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-required-title"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-950 px-6 py-10 text-center text-zinc-200"
    >
      <img
        src="/icons/icon-192.png"
        alt=""
        width={64}
        height={64}
        className="h-16 w-16 rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
      />
      <div className="space-y-2">
        <h1
          id="install-required-title"
          className="text-xl font-bold tracking-tight text-zinc-100"
        >
          {installed ? "Amazon King is installed" : "Install Amazon King"}
        </h1>
        <p className="text-sm text-zinc-400">
          {installed
            ? "Open it from your home screen to continue. This browser tab stays locked."
            : "On phones Amazon King only runs as a home-screen app. The browser tab cannot be used."}
        </p>
      </div>
      {!installed && (
        <p className="max-w-xs text-sm leading-relaxed text-zinc-300">
          {instructions(method)}
        </p>
      )}
      {!installed && method === "native" && (
        <Button type="button" variant="primary" onClick={install}>
          Install
        </Button>
      )}
      <p className="text-xs text-zinc-500">
        Already installed? Open Amazon King from your home screen.
      </p>
      {import.meta.env.DEV && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setContinueInBrowser(true)}
        >
          Continue in browser (dev only)
        </Button>
      )}
    </div>
  );
}
