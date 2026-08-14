import { useEffect, useState } from "react";

/**
 * Fired by Chromium when the site meets the PWA installability criteria
 * (HTTPS, manifest, service worker). Not part of the standard Event union.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "amazon-king.install-banner-dismissed";

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS/iPadOS Safari has no programmatic install prompt; users must use Share → Add to Home Screen. */
function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  const isIos =
    /iP(hone|ad|od)/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIos && isSafari;
}

type BannerState = "hidden" | "native" | "ios";

/**
 * Mobile-only banner prompting the user to install the app on the home
 * screen. Shown only when the browser can actually install (Chromium fires
 * `beforeinstallprompt`, or iOS Safari where we show manual instructions).
 * Hidden in standalone mode and after dismissal (persisted).
 */
export function InstallBanner() {
  const [state, setState] = useState<BannerState>("hidden");
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone()) return;
    if (window.localStorage.getItem(DISMISS_KEY) === "1") return;

    if (isIosSafari()) {
      setState("ios");
      return;
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setState("native");
    };
    const onAppInstalled = () => {
      setState("hidden");
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  if (state === "hidden") return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    setState("hidden");
  };

  const install = () => {
    if (!deferredPrompt) return;
    void deferredPrompt.prompt().then(() => {
      void deferredPrompt.userChoice.finally(() => {
        setDeferredPrompt(null);
        setState("hidden");
      });
    });
  };

  return (
    <div
      role="region"
      aria-label="Install app"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-700 bg-zinc-900/95 px-4 py-3 backdrop-blur md:hidden"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-sm font-bold text-white"
        >
          AK
        </span>
        <p className="min-w-0 flex-1 text-sm text-zinc-200">
          {state === "native" ? (
            "Install Amazon King for full-screen use without the browser bar."
          ) : (
            <>
              Install Amazon King: tap <span aria-hidden="true">⎋</span>
              <span className="sr-only">Share</span> in Safari, then{" "}
              <strong>Add to Home Screen</strong>.
            </>
          )}
        </p>
        {state === "native" && (
          <button
            type="button"
            onClick={install}
            className="shrink-0 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          >
            Install
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss install prompt"
          onClick={dismiss}
          className="shrink-0 rounded-lg px-2 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
