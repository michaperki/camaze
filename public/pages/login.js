import * as supabase from '@supabase/supabase-js';
// No header.js on this page, so the toggle wires itself up here instead
// of sharing header.js's copy of this same logic — same "camaze-theme"
// key /theme-init.js already read on load.
(function () {
  const THEME_KEY = "camaze-theme";
  const btn = document.getElementById("theme-toggle-btn");
  function isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }
  function update() {
    const dark = isDark();
    btn.textContent = dark ? "☀" : "☾";
    btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    btn.title = btn.getAttribute("aria-label");
  }
  btn.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    if (next === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    update();
  });
  update();
})();

const statusEl = document.getElementById("status");
const googleBtn = document.getElementById("google-btn");
const form = document.getElementById("magic-link-form");
const emailInput = document.getElementById("email-input");
const magicLinkBtn = document.getElementById("magic-link-btn");

function showStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.style.display = "block";
}

const redirectTo = window.location.origin + "/dashboard.html";

(async () => {
  const cfgRes = await fetch("/api/config");
  const cfg = await cfgRes.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    showStatus("Auth is not configured (missing SUPABASE_URL/SUPABASE_ANON_KEY).", "error");
    googleBtn.disabled = true;
    magicLinkBtn.disabled = true;
    return;
  }

  const client = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Already signed in? Skip the login page.
  const { data: { session } } = await client.auth.getSession();
  if (session) {
    window.location.replace("/dashboard.html");
    return;
  }

  googleBtn.addEventListener("click", async () => {
    googleBtn.disabled = true;
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) {
      showStatus(error.message, "error");
      googleBtn.disabled = false;
    }
    // On success the browser navigates away to Google's consent screen.
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    magicLinkBtn.disabled = true;
    magicLinkBtn.textContent = "Sending…";
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) {
      showStatus(error.message, "error");
      magicLinkBtn.disabled = false;
      magicLinkBtn.textContent = "Send magic link";
      return;
    }
    form.style.display = "none";
    showStatus(`Check ${email} for a sign-in link.`, "success");
  });
})();
