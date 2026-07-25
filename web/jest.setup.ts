import "@testing-library/jest-dom";
import "jest-canvas-mock";

// jsdom does not implement matchMedia. uPlot (used by TimeChart) queries it at
// module-load time to pick a devicePixelRatio-change strategy, so without this
// stub any test that imports uplot (even indirectly) fails before it can run.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
