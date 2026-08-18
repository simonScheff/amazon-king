import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia. Default every query to "no match" so components that
// ask about display mode (the install gate, the sign-in paste fallback) render;
// tests that care override it.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
