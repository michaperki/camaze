// Renders the shared marketing header + footer into empty
// <header id="app-header"></header> / <footer id="site-footer"></footer>
// mounts. Separate from header.js and its nav on purpose — a logged-out
// visitor on a marketing page should see Attribution/Alerts/Planning/
// Reports/Integrations/Pricing, never Dashboard/Gateway/Assignments.
// Reuses the app header's own CSS (#app-header/.header-inner/.wordmark/
// nav.tabs in shared.css) so the two feel like one site, not two.
(function () {
  const NAV = [
    { href: "/attribution", label: "Attribution" },
    { href: "/alerts", label: "Alerts" },
    { href: "/planning", label: "Planning" },
    { href: "/reports", label: "Reports" },
    { href: "/integrations", label: "Integrations" },
    { href: "/pricing", label: "Pricing" },
  ];

  function normalize(pathname) {
    return pathname.replace(/\/+$/, "") || "/";
  }

  function renderMarketingHeader() {
    const mount = document.getElementById("app-header");
    if (!mount) return;
    const current = normalize(window.location.pathname);
    const links = NAV.map((item) => {
      const active = normalize(item.href) === current;
      return `<a href="${item.href}"${active ? ' class="active"' : ""}>${item.label}</a>`;
    }).join("");
    mount.innerHTML =
      '<div class="header-inner">' +
      '<a class="wordmark" href="/">camaze</a>' +
      `<nav class="tabs">${links}</nav>` +
      '<a class="signin-link" href="/login.html">Sign in</a>' +
      "</div>";
  }

  function renderMarketingFooter() {
    const mount = document.getElementById("site-footer");
    if (!mount) return;
    mount.innerHTML =
      '<div class="footer-inner">' +
      '<span>camaze</span>' +
      '<nav><a href="/pricing">Pricing</a><a href="/login.html">Sign in</a></nav>' +
      "</div>";
  }

  renderMarketingHeader();
  renderMarketingFooter();
})();
