// Blocking (no defer/async), and the first thing in every app page's
// <head> — sets [data-theme] on <html> from localStorage before the
// browser paints, so a returning dark-mode visitor never sees a flash
// of the light page first. header.js's toggle button writes the same
// "camaze-theme" key and flips the same attribute at runtime; this
// script only handles the pre-paint read on load.
(function () {
  try {
    if (localStorage.getItem("camaze-theme") === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  } catch (e) {
    // localStorage unavailable (private mode, disabled) — falls back to
    // the light default, same as a first-time visitor.
  }
})();
