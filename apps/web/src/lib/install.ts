/**
 * Fired by Chromium when the site meets the PWA installability criteria
 * (HTTPS, manifest, service worker). Not part of the standard Event union.
 */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export const STANDALONE_QUERY = "(display-mode: standalone)";

/** True when the page runs as the installed app rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia(STANDALONE_QUERY).matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  const ua = window.navigator.userAgent;
  return (
    /iP(hone|ad|od)/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** iOS/iPadOS Safari has no programmatic install prompt; users must use Share → Add to Home Screen. */
export function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  const isSafari = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIos() && isSafari;
}

/**
 * Phones only, from the user agent rather than the viewport: a narrow desktop
 * window is still a desktop browser, and an iPhone in landscape is still a
 * phone. iPadOS Safari reports a Mac user agent and is therefore treated as a
 * desktop, which is intended — tablets keep plain browser access.
 */
export function isPhone(): boolean {
  const ua = window.navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return true;
  if (/Android/.test(ua)) return /Mobile/.test(ua);
  return /Mobile|Silk/.test(ua) && !/iPad|Tablet/.test(ua);
}
