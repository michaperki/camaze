// Renders the shared app header (wordmark + nav tabs + sign-out slot) into
// an empty <header id="app-header"></header> mount. Single source for the
// header markup so it can't drift page to page the way it did when each
// page hand-copied this block — see the four pages under public/ that use
// it. Runs synchronously, before each page's own script, so #header-right/
// #user-email/#signout-btn exist by the time that script looks for them.
(function () {
  const NAV = [
    { href: "/dashboard.html", label: "Dashboard" },
    { href: "/integrations.html", label: "Integrations" },
    { href: "/notifications.html", label: "Notifications" },
    { href: "/gateway.html", label: "Gateway" },
  ];

  // "/dashboard.html", "/dashboard.html/", and "/dashboard" (if ever
  // served extension-less) should all count as the same tab — strip a
  // trailing slash, then a .html extension, and compare on that.
  function normalize(pathname) {
    return pathname.replace(/\/+$/, "").replace(/\.html$/, "") || "/";
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
      '<button id="signout-btn" type="button">Sign out</button>' +
      "</div>" +
      "</div>";
  }

  renderAppHeader();
})();
