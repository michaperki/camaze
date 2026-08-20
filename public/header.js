// Renders the shared app header (wordmark + nav tabs + sign-out slot) into
// an empty <header id="app-header"></header> mount. Single source for the
// header markup so it can't drift page to page the way it did when each
// page hand-copied this block — see the four pages under public/ that use
// it. Runs synchronously, before each page's own script, so #header-right/
// #user-email/#signout-btn exist by the time that script looks for them.
//
// Also owns the dark-mode toggle next to sign-out: this is the one place
// that both renders the button and knows how to flip the theme, so
// there's a single source for that logic too. /theme-init.js (loaded
// separately, first thing in <head>) only handles the pre-paint read —
// it can't render a button that doesn't exist yet at that point in the
// page.
(function () {
  const NAV = [
    { href: "/dashboard.html", label: "Dashboard" },
    { href: "/integrations.html", label: "Integrations" },
    { href: "/notifications.html", label: "Notifications" },
    { href: "/gateway.html", label: "Gateway" },
    { href: "/assignments.html", label: "Assignments" },
  ];

  const THEME_KEY = "camaze-theme";

  // "/dashboard.html", "/dashboard.html/", and "/dashboard" (if ever
  // served extension-less) should all count as the same tab — strip a
  // trailing slash, then a .html extension, and compare on that.
  function normalize(pathname) {
    return pathname.replace(/\/+$/, "").replace(/\.html$/, "") || "/";
  }

  function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function updateToggleButton() {
    const btn = document.getElementById("theme-toggle-btn");
    if (!btn) return;
    const dark = isDark();
    btn.textContent = dark ? "☀" : "☾";
    btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    btn.title = btn.getAttribute("aria-label");
  }

  function toggleTheme() {
    const next = isDark() ? "light" : "dark";
    if (next === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) {
      // localStorage unavailable — theme still applies for this load,
      // it just won't persist across a reload.
    }
    updateToggleButton();
  }

  function renderAppHeader() {
    const mount = document.getElementById("app-header");
    if (!mount) return;
    const current = normalize(window.location.pathname);
    const links = NAV.map((item) => {
      const active = normalize(item.href) === current;
      return `<a href="${item.href}"${active ? ' class="active"' : ""}>${item.label}</a>`;
    }).join("");
    mount.innerHTML =
      '<div class="header-inner">' +
      '<a class="wordmark" href="/dashboard.html">camaze</a>' +
      `<nav class="tabs">${links}</nav>` +
      '<div class="header-right" id="header-right">' +
      '<span id="user-email"></span>' +
      '<button id="theme-toggle-btn" type="button"></button>' +
      '<button id="signout-btn" type="button">Sign out</button>' +
      "</div>" +
      "</div>";
    updateToggleButton();
    document.getElementById("theme-toggle-btn").addEventListener("click", toggleTheme);
  }

  renderAppHeader();
})();
