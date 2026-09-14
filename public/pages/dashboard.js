import { renderSpendChart, destroySpendChart } from '../components/spend-chart.js';
import * as supabase from '@supabase/supabase-js';
import '../header.js';
const SERIES_VARS = {
  anthropic: "var(--series-1)",
  openai: "var(--series-2)",
  google: "var(--series-3)",
};

// Matches lib/org.js's UNASSIGNED sentinel — defensive fallback only; every
// attribution row from api/costs.js already carries a `department` field.
const UNASSIGNED_DEPT = { id: null, name: "Unassigned" };

// Client-side month selection — { year, month: 1-12 }, all UTC to match
// how every date in this dashboard is already bucketed. Passed to
// /api/costs as ?month=YYYY-MM; the backend scopes every provider call and
// the summary computation to exactly that calendar month.
function currentMonthUTC() {
  const now = window.camazeNow();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}
let selectedMonth = currentMonthUTC();

const monthStr = (sel) => `${sel.year}-${String(sel.month).padStart(2, "0")}`;
const monthLabel = (sel) =>
  new Date(Date.UTC(sel.year, sel.month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const isSelectedMonthCurrent = (sel) => {
  const c = currentMonthUTC();
  return sel.year === c.year && sel.month === c.month;
};
function shiftMonth(sel, delta) {
  const d = new Date(Date.UTC(sel.year, sel.month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

const fmtUSD = (v, opts = {}) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", ...opts });

const fmtDate = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });

const esc = (s) => String(s).replace(/</g, "&lt;");

const REDUCED_MOTION = typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Ticks a stat's displayed number from its previous value to `to` instead
// of snapping straight to it — lets a sim day/month advance (or a plain
// month-nav click) actually be watched moving rather than compared against
// what the page said a moment ago. `from` omitted (first paint, or the
// stat wasn't shown before) means no animation, just the final value.
function animateNumber(el, to, fmt, from) {
  if (!el) return;
  if (REDUCED_MOTION || from == null || from === to || !Number.isFinite(from) || !Number.isFinite(to)) {
    el.textContent = fmt(to);
    return;
  }
  cancelAnimationFrame(el._simRaf);
  const start = performance.now();
  const DURATION = 550;
  const step = (now) => {
    const t = Math.min(1, (now - start) / DURATION);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (t < 1) el._simRaf = requestAnimationFrame(step);
  };
  el._simRaf = requestAnimationFrame(step);
}

// Previous-render values for the headline numbers above — read by
// animateNumber() as the "from" on the next render, written right after.
let prevChartTotal = null;
let prevSummary = { mtd: null, forecast: null, budget: null };
let prevBudgetPct = null;

// Width-transition continuity for the breakdown bars (models/attribution/
// departments/top spenders/budget) — see the .model-bar/.budget-bar
// comment in <style> above. Every render() function below rebuilds its
// rows' markup from scratch on every call (a sim tick, a month-nav click,
// ...), so a bar can't rely on the browser's normal implicit transition
// (same element, new style) — the element itself is brand new each time.
// Instead each render function stashes the bar's rendered *width
// percentage* (not the raw dollar amount — these bars are proportional to
// the render's own max, so another row growing can shift this one's pct
// even though its own amount didn't move) into its own key -> pct map,
// reads the previous map before overwriting it, sets each bar's initial
// inline width to its old pct (0 for a row that didn't exist before), and
// calls growBars() right after to flip every bar to its real target width
// on the next frame — a plain CSS transition, so a bar that didn't
// actually move just doesn't.
function growBars(container) {
  if (!container) return;
  const bars = container.querySelectorAll("[data-grow]");
  if (bars.length === 0) return;
  if (REDUCED_MOTION) {
    bars.forEach((el) => { el.style.width = el.dataset.grow + "%"; });
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bars.forEach((el) => { el.style.width = el.dataset.grow + "%"; });
    });
  });
}

function fmtAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins <= 0) return "just now";
  if (mins < 60) return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function render({ providers, days, totals, errors, cached, cachedAt }) {
  const content = document.getElementById("content");
  const description = document.getElementById("chart-description");
  const active = providers.filter(p => !p.failed);

  // Per-provider failure notes (shown above the chart, plainly).
  let notes = "";
  for (const p of providers) {
    if (!p.failed) continue;
    const others = active.map(a => a.label).join(", ");
    notes += `<div class="note"><strong>${esc(p.label)}</strong>: ${esc(errors[p.name])}` +
      (others ? ` — showing ${esc(others)} only.` : "") + "</div>";
  }

  if (active.length === 0) {
    description.textContent = "";
    content.innerHTML = `<div class="notes">${notes}</div>` +
      '<div class="message">No provider data could be loaded.</div>';
    prevChartTotal = null;
    destroySpendChart();
    return;
  }

  const meta = cached && cachedAt
    ? `<div class="stat-meta">as of ${esc(fmtAgo(cachedAt))} &middot; refreshes every 5 min</div>`
    : "";

  // Bars are usage only (a flat subscription can't spike, so it never
  // belongs in them) — the total line makes the full bill visible anyway,
  // split out rather than folded silently into one number. Lives in the
  // card's panel-description now rather than inline above the chart.
  description.innerHTML = totals.subscriptions > 0
    ? `<span class="chart-total-amount" id="chart-total-amount">${fmtUSD(totals.combined)}</span> total — ${fmtUSD(totals.usage)} usage, ${fmtUSD(totals.subscriptions)} subscriptions`
    : `<span class="chart-total-amount" id="chart-total-amount">${fmtUSD(totals.combined)}</span> total`;
  animateNumber(document.getElementById("chart-total-amount"), totals.combined, fmtUSD, prevChartTotal);
  prevChartTotal = totals.combined;

  const legendHtml =
    '<div class="chart-legend">' +
    active.map(p =>
      `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${SERIES_VARS[p.name]}"></span>` +
      `${esc(p.label)} <span class="chart-legend-total">${fmtUSD(totals[p.name])}</span></span>`
    ).join("") +
    "</div>";
  const topContent = meta + (notes ? `<div class="notes">${notes}</div>` : "");

  if (days.every(d => active.every(p => d[p.name] === 0))) {
    content.innerHTML = topContent + '<div class="message">No spend recorded in this period.</div>' + legendHtml;
    destroySpendChart();
    return;
  }

  if (!content.querySelector('#usage-chart')) {
    destroySpendChart();
    content.innerHTML = '<div id="chart-notes"></div><div id="usage-chart"></div><div id="chart-totals"></div>';
  }
  content.querySelector('#chart-notes').innerHTML = topContent;
  content.querySelector('#chart-totals').innerHTML = legendHtml;
  renderSpendChart(content.querySelector('#usage-chart'), { days, providers: active });
}

// Raw model IDs aren't how anyone talks about these models — reformat the
// common Anthropic/OpenAI naming patterns into something readable. Google's
// `model` is already sku.description text from GCP, so it's left as-is.
function prettifyModel(provider, model) {
  if (provider === "anthropic") {
    // "claude-sonnet-4-6" -> "Claude Sonnet 4.6"; "claude-haiku-4-5-20251001"
    // -> "Claude Haiku 4.5" (snapshot date suffix dropped).
    const parts = model.replace(/-\d{8}$/, "").split("-");
    if (parts[0] !== "claude" || parts.length < 2) return model;
    const family = parts[1][0].toUpperCase() + parts[1].slice(1);
    const versionParts = parts.slice(2);
    if (versionParts.length === 0) return `Claude ${family}`;
    const version = versionParts.every(p => /^\d+$/.test(p))
      ? versionParts.join(".")
      : versionParts.join(" ");
    return `Claude ${family} ${version}`;
  }
  if (provider === "openai") {
    // "gpt-5.2-2025-12-11" -> "GPT-5.2"; "gpt-4o-mini-2024-07-18" -> "GPT-4o mini".
    const stripped = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    const m = stripped.match(/^gpt-([0-9.]+[a-z]*)(-(.+))?$/i);
    if (!m) return stripped;
    return `GPT-${m[1]}${m[3] ? " " + m[3].replace(/-/g, " ") : ""}`;
  }
  if (provider === "google") {
    // The billing export's goog-generativelanguage-model label strips dots
    // and dashes: "gemini-2.5-flash" -> "gemini25flash". Reconstruct the
    // version number (first 1-2 digits after "gemini") and split the rest
    // against a fixed vocabulary of known model-name words. A row that
    // isn't this label at all (e.g. a raw sku.description fallback, which
    // already reads as English) or a suffix we don't recognize is shown
    // as-is rather than guessed at.
    const m = model.match(/^gemini(\d)(\d)?([a-z0-9]*)$/i);
    if (!m) return model;
    const [, major, minor, rest] = m;
    const version = minor ? `${major}.${minor}` : major;
    const WORDS = ["flash", "pro", "lite", "nano", "ultra", "preview", "experimental", "exp",
      "vision", "live", "image", "audio", "embedding", "thinking", "8b", "2b"];
    const words = [];
    let s = rest.toLowerCase();
    while (s.length > 0) {
      const w = WORDS.find(w => s.startsWith(w));
      if (!w) return model; // unrecognized suffix — don't guess
      words.push(/^\d+b$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
      s = s.slice(w.length);
    }
    return ["Gemini", version, ...words].join(" ");
  }
  return model;
}

let lastModels = [];
let lastAttribution = [];
let lastModelsPct = new Map();
let lastAttributionPct = new Map();

function renderModels(models) {
  const previousPct = lastModelsPct;
  lastModels = models || [];
  updateBreakdownCardVisibility();
  if (lastModels.length === 0) {
    document.getElementById("models-content").innerHTML = "";
    lastModelsPct = new Map();
    return;
  }

  const maxAmount = Math.max(...lastModels.map(m => m.amount_usd));
  const totalAmount = lastModels.reduce((sum, m) => sum + m.amount_usd, 0);
  const nextPct = new Map();
  document.getElementById("models-content").innerHTML = lastModels.map(m => {
    // A zero-amount row must draw no bar at all — flooring it to 1% (or
    // relying on .model-bar's min-width) would render a sliver for a
    // model that cost nothing.
    const pct = m.amount_usd > 0 && maxAmount > 0 ? Math.max((m.amount_usd / maxAmount) * 100, 1) : 0;
    const share = totalAmount > 0 ? (m.amount_usd / totalAmount) * 100 : 0;
    const shareLabel = share > 0 && share < 1 ? share.toFixed(1) : Math.round(share);
    const fill = SERIES_VARS[m.provider] || "var(--text-muted)";
    const label = prettifyModel(m.provider, m.model);
    const key = `${m.provider}|${m.model}`;
    nextPct.set(key, pct);
    const fromPct = previousPct.get(key) ?? 0;
    return (
      '<div class="model-row">' +
      `<span class="model-label" title="${esc(m.model)}">${esc(label)}</span>` +
      '<div class="model-bar-track">' +
      (pct > 0 ? `<div class="model-bar" data-grow="${pct}" style="width:${fromPct}%;background:${fill}"></div>` : "") +
      "</div>" +
      '<span class="model-stats">' +
      `<span class="model-pct">${shareLabel}%</span>` +
      `<span class="model-amount">${fmtUSD(m.amount_usd)}</span>` +
      "</span>" +
      "</div>"
    );
  }).join("");
  lastModelsPct = nextPct;
  growBars(document.getElementById("models-content"));
}

// The backend already picks one scope per provider (api_key vs workspace
// vs project — see lib/costs.js's PROVIDER_SCOPE_PREFERENCE), so rows never
// mix hierarchy levels within a provider. This groups by provider and shows
// each as its own labeled section — bars are only ever compared within a
// provider's own group, never across providers with different scopes.
const PROVIDER_LABELS = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };
const SCOPE_LABELS = { api_key: "by API key", workspace: "by workspace", project: "by project" };
const PROVIDER_ORDER = ["anthropic", "openai", "google"];

function renderAttribution(attribution) {
  const unpricedNote = document.getElementById("attribution-unpriced-note");
  const previousPct = lastAttributionPct;
  lastAttribution = attribution || [];
  updateBreakdownCardVisibility();
  if (lastAttribution.length === 0) {
    document.getElementById("attribution-content").innerHTML = "";
    unpricedNote.style.display = "none";
    lastAttributionPct = new Map();
    return;
  }

  // Under-reporting must never be invisible: if any row hit a model with no
  // price-map entry, name every one of them here rather than letting the
  // amount look complete when it's actually a partial total.
  const unpricedModels = new Set();
  for (const row of attribution) {
    for (const m of row.unpricedModels || []) unpricedModels.add(m);
  }
  if (unpricedModels.size > 0) {
    unpricedNote.textContent =
      `Spend on ${[...unpricedModels].sort().join(", ")} isn't priced yet, so totals for the affected ` +
      `keys/projects are undercounted — token counts were recorded but not converted to dollars.`;
    unpricedNote.style.display = "block";
  } else {
    unpricedNote.style.display = "none";
  }

  const groups = new Map(); // provider -> rows
  for (const row of attribution) {
    if (!groups.has(row.provider)) groups.set(row.provider, []);
    groups.get(row.provider).push(row);
  }

  const order = PROVIDER_ORDER.filter(p => groups.has(p))
    .concat([...groups.keys()].filter(p => !PROVIDER_ORDER.includes(p)));

  const nextPct = new Map();
  document.getElementById("attribution-content").innerHTML = order.map(providerName => {
    const rows = groups.get(providerName).slice().sort((a, b) => b.amount_usd - a.amount_usd);
    const maxAmount = Math.max(...rows.map(r => r.amount_usd));
    const fill = SERIES_VARS[providerName] || "var(--text-muted)";
    const scopeLabel = SCOPE_LABELS[rows[0].scope] || "";

    const label =
      `<div class="attribution-group-label">${esc(PROVIDER_LABELS[providerName] || providerName)}` +
      (scopeLabel ? ` <span class="attribution-scope">${esc(scopeLabel)}</span>` : "") +
      "</div>";

    const bars = rows.map(a => {
      // See the zero-amount guard in renderModels — same reasoning applies
      // here (e.g. a provider's "Default project" scope that spent $0).
      const pct = a.amount_usd > 0 && maxAmount > 0 ? Math.max((a.amount_usd / maxAmount) * 100, 1) : 0;
      // The "est." explanation used to be a standalone footnote line, which
      // wrapped awkwardly at this card's narrower width — a tooltip on the
      // badge itself carries the same explanation without needing layout
      // space, the same way the "unpriced" badge already works.
      const estBadge = a.estimated
        ? ` <span class="badge badge-secondary" title="Derived from token counts, not billed dollars — Anthropic doesn't report per-API-key cost directly.">est.</span>`
        : "";
      const unpricedBadge = a.unpriced
        ? ` <span class="badge badge-warning" title="${esc((a.unpricedModels || []).join(', '))}">unpriced</span>`
        : "";
      const key = `${a.provider}|${a.scope}|${a.name}`;
      nextPct.set(key, pct);
      const fromPct = previousPct.get(key) ?? 0;
      return (
        '<div class="model-row">' +
        `<span class="model-label" title="${esc(a.name)}">${esc(a.name)}</span>` +
        '<div class="model-bar-track">' +
        (pct > 0 ? `<div class="model-bar" data-grow="${pct}" style="width:${fromPct}%;background:${fill}"></div>` : "") +
        "</div>" +
        '<span class="model-stats">' +
        `<span class="model-amount">${fmtUSD(a.amount_usd)}${estBadge}${unpricedBadge}</span>` +
        "</span>" +
        "</div>"
      );
    }).join("");

    // No wrapping element around label+bars: #attribution-content is one
    // shared grid (see its CSS), so the label and every group's rows need
    // to be direct children of it for their columns to align.
    return label + bars;
  }).join("");
  lastAttributionPct = nextPct;
  growBars(document.getElementById("attribution-content"));
}

// Spend-by-department breakdown, grouped from the same attribution rows
// the By-project tab already has (see lib/org.js's resolveAttribution) — no
// separate fetch. Unassigned is just whatever group key `null` collects:
// never excluded, never merged into another department, sorted by spend
// like every other row rather than pinned to a fixed position.
let lastDepartments = [];
let lastDepartmentsPct = new Map();

function renderDepartmentBreakdown(attribution) {
  const previousPct = lastDepartmentsPct;
  const groups = new Map(); // department id ("unassigned" for null) -> { department, amount_usd }
  for (const row of attribution || []) {
    const dept = row.department || UNASSIGNED_DEPT;
    const key = dept.id ?? "unassigned";
    if (!groups.has(key)) groups.set(key, { department: dept, amount_usd: 0 });
    groups.get(key).amount_usd += row.amount_usd;
  }
  lastDepartments = [...groups.values()].sort((a, b) => b.amount_usd - a.amount_usd);
  updateBreakdownCardVisibility();

  const content = document.getElementById("departments-content");
  if (lastDepartments.length === 0) {
    content.innerHTML = "";
    lastDepartmentsPct = new Map();
    return;
  }

  const maxAmount = Math.max(...lastDepartments.map(d => d.amount_usd));
  const nextPct = new Map();
  content.innerHTML = lastDepartments.map((d) => {
    const isUnassigned = d.department.id === null;
    // Same zero-amount guard as renderModels — draw no bar for a $0 row.
    const pct = d.amount_usd > 0 && maxAmount > 0 ? Math.max((d.amount_usd / maxAmount) * 100, 1) : 0;
    // budgetStatus() is the exact function the overall Budget stat card
    // uses (see below) — reused here, not reimplemented, against this
    // department's own monthly_budget_usd instead of the account total.
    const status = isUnassigned ? null : budgetStatus(d.amount_usd, d.department.monthly_budget_usd);
    // Unassigned is always drawn in the warning color regardless of budget
    // (it has none) — an untagged key needs to read as "needs attention,"
    // not blend in as just another department.
    const fill = isUnassigned ? "var(--warning)" : (status ? `var(--${status})` : "var(--accent)");

    let perEmployee = "";
    if (!isUnassigned) {
      if (d.department.headcount > 0) {
        perEmployee = `<span class="model-pct">${fmtUSD(d.amount_usd / d.department.headcount)}/person</span>`;
      } else {
        perEmployee = `<span class="model-pct" title="Set headcount for this department on the Assignments page to see cost per employee">no headcount</span>`;
      }
    }
    const unassignedBadge = isUnassigned
      ? ` <span class="badge badge-warning" title="Spend from keys/projects with no department or owner set — assign them on the Assignments page">unassigned</span>`
      : "";
    const amountClass = "model-amount" + (status ? ` stat-${status}` : "");
    const key = d.department.id ?? "unassigned";
    nextPct.set(key, pct);
    const fromPct = previousPct.get(key) ?? 0;

    return (
      '<div class="model-row">' +
      `<span class="model-label" title="${esc(d.department.name)}">${esc(d.department.name)}</span>` +
      '<div class="model-bar-track">' +
      (pct > 0 ? `<div class="model-bar" data-grow="${pct}" style="width:${fromPct}%;background:${fill}"></div>` : "") +
      "</div>" +
      '<span class="model-stats">' +
      perEmployee +
      `<span class="${amountClass}">${fmtUSD(d.amount_usd)}${unassignedBadge}</span>` +
      "</span>" +
      "</div>"
    );
  }).join("");
  lastDepartmentsPct = nextPct;
  growBars(content);
}

// Top spenders, grouped the same way by row.person instead of
// row.department — only populated from person-level assignments, so a rows
// with no owner just don't contribute here (they're the Unassigned
// department's problem, not this list's). The whole tab hides itself when
// nobody has been assigned as an owner yet, rather than showing an empty
// leaderboard.
let lastTopSpenders = [];
let lastTopSpendersPct = new Map();

function renderTopSpenders(attribution) {
  const previousPct = lastTopSpendersPct;
  const groups = new Map(); // person id -> { person, amount_usd }
  for (const row of attribution || []) {
    if (!row.person) continue;
    const key = row.person.id;
    if (!groups.has(key)) groups.set(key, { person: row.person, amount_usd: 0 });
    groups.get(key).amount_usd += row.amount_usd;
  }
  lastTopSpenders = [...groups.values()].sort((a, b) => b.amount_usd - a.amount_usd);

  const tab = document.getElementById("tab-people");
  tab.style.display = lastTopSpenders.length > 0 ? "" : "none";
  if (lastTopSpenders.length === 0) {
    document.getElementById("people-content").innerHTML = "";
    lastTopSpendersPct = new Map();
    if (breakdownTab === "people") breakdownTab = "models";
    applyBreakdownTab();
    return;
  }

  const maxAmount = Math.max(...lastTopSpenders.map(p => p.amount_usd));
  const nextPct = new Map();
  const peopleContent = document.getElementById("people-content");
  peopleContent.innerHTML = lastTopSpenders.map((p) => {
    const pct = p.amount_usd > 0 && maxAmount > 0 ? Math.max((p.amount_usd / maxAmount) * 100, 1) : 0;
    nextPct.set(p.person.id, pct);
    const fromPct = previousPct.get(p.person.id) ?? 0;
    return (
      '<div class="model-row">' +
      `<span class="model-label" title="${esc(p.person.name)}">${esc(p.person.name)}</span>` +
      '<div class="model-bar-track">' +
      (pct > 0 ? `<div class="model-bar" data-grow="${pct}" style="width:${fromPct}%;background:var(--accent)"></div>` : "") +
      "</div>" +
      '<span class="model-stats">' +
      `<span class="model-amount">${fmtUSD(p.amount_usd)}</span>` +
      "</span>" +
      "</div>"
    );
  }).join("");
  lastTopSpendersPct = nextPct;
  growBars(peopleContent);
  applyBreakdownTab();
}

// Shared card for all four breakdown tabs — visible whenever any has data,
// independent of which tab is currently active.
function updateBreakdownCardVisibility() {
  document.getElementById("breakdown-card").style.display =
    (lastModels.length > 0 || lastAttribution.length > 0) ? "block" : "none";
}

const BREAKDOWN_TABS = ["models", "attribution", "departments", "people"];
let breakdownTab = "models";

function applyBreakdownTab() {
  // If the active tab was just hidden (e.g. top spenders lost its last
  // person-level assignment), fall back to Models rather than leaving
  // every pane hidden.
  const activeTabEl = document.getElementById(`tab-${breakdownTab}`);
  if (!activeTabEl || activeTabEl.style.display === "none") breakdownTab = "models";

  for (const t of BREAKDOWN_TABS) {
    const isActive = t === breakdownTab;
    const tabEl = document.getElementById(`tab-${t}`);
    tabEl.classList.toggle("active", isActive);
    tabEl.setAttribute("aria-selected", String(isActive));
    document.getElementById(`${t}-pane`).classList.toggle("pane-hidden", !isActive);
  }
}

for (const t of BREAKDOWN_TABS) {
  document.getElementById(`tab-${t}`).addEventListener("click", () => {
    breakdownTab = t;
    applyBreakdownTab();
  });
}

// `total`: the section's true total (lib/costs.js's totals.subscriptions),
// summed before the >= $0.01 row filter — rows that individually round to
// zero (e.g. BigQuery's "Active Logical Storage") can still add up to
// something worth showing, even once they're dropped from the row list.
function renderSubscriptions(subscriptions, total) {
  const card = document.getElementById("subscriptions-card");
  const rows = subscriptions || [];
  const totalAmount = total ?? rows.reduce((sum, s) => sum + s.amount_usd, 0);
  if (totalAmount < 0.01) {
    card.style.display = "none";
    card.open = false;
    return;
  }
  card.style.display = "block";

  document.getElementById("subscriptions-summary").innerHTML =
    `Subscriptions &amp; other charges &mdash; <span class="subscriptions-total">${fmtUSD(totalAmount)}</span>`;

  document.getElementById("subscriptions-content").innerHTML = rows.map(s =>
    '<div class="subscription-row">' +
    `<span class="subscription-name">${esc(s.name)}` +
    (s.manual ? ` <span class="badge badge-secondary" title="Manually entered on the Integrations page — not reported by a provider API">manual</span>` : "") +
    (s.amortized ? ` <span class="badge badge-secondary" title="Billed ${esc(fmtUSD(s.annual_usd))}/year on ${esc(billsOnLabel(s.bills_on))} — shown here divided evenly across each month, so it won't match your card statement in the month it actually bills">amortized</span>` : "") +
    "</span>" +
    `<span class="subscription-amount">${fmtUSD(s.amount_usd)}</span>` +
    "</div>"
  ).join("");
}

// "YYYY-MM-DD" -> "Mar 14" — an annual fixed cost's started_on date is the
// month/day it re-bills every year (see api/costs.js's `bills_on`); the
// year it was first entered isn't the relevant part for that.
function billsOnLabel(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// "YYYY-MM" -> "Jul 2026", for reconciliation rows (see lib/reconcile.js),
// which carry a plain month string rather than the {year,month} shape
// selectedMonth uses elsewhere.
function monthStrLabel(monthStr) {
  const [year, month] = monthStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// Reconciliation (see lib/reconcile.js) compares stored daily_costs against
// a live fetch and flags 'drift' when they disagree by more than a cent —
// this is the guard on the whole sync layer, so a drift entry gets a loud,
// always-visible banner rather than a console warning nobody sees. Not
// scoped to the currently-viewed month: `reconciliation` is "the most
// recent check per provider," independent of month navigation. One
// "Re-sync this month" button per distinct drifted month (usually just
// one) — clicking it re-syncs + re-checks just that month (resyncMonth
// below), never the whole dashboard's worth of provider traffic.
function renderDriftBanner(reconciliation) {
  const banner = document.getElementById("drift-banner");
  const drifted = (reconciliation || []).filter(r => r.status === "drift");
  if (drifted.length === 0) {
    banner.style.display = "none";
    return;
  }
  const monthsWithButton = new Set();
  banner.innerHTML = drifted
    .map(r => {
      // One button per distinct month — usually there's only one drifted
      // month at a time, but if two providers drifted in the same month a
      // single re-sync covers both.
      let btn = "";
      if (!monthsWithButton.has(r.month)) {
        monthsWithButton.add(r.month);
        btn = `<button type="button" class="resync-btn" data-action="resync-month" data-month="${esc(r.month)}">Re-sync this month</button>`;
      }
      return `<span class="drift-item">⚠ <strong>${esc(PROVIDER_LABELS[r.provider] || r.provider)}</strong> for ` +
        `${esc(monthStrLabel(r.month))} is off by ${fmtUSD(Math.abs(r.diff_usd))} from what the provider reports.${btn}</span>`;
    })
    .join("");
  banner.style.display = "block";
}

// Providers whose last 3 consecutive reconciliation runs all failed to even
// check (see lib/reconcile.js's getReconciliationStatus) — deliberately
// separate from the drift banner above: this means "unknown," not "wrong,"
// so it gets its own warning-colored (not danger-colored) box.
function renderUnverifiableBanner(unverifiable) {
  const banner = document.getElementById("unverifiable-banner");
  const rows = unverifiable || [];
  if (rows.length === 0) {
    banner.style.display = "none";
    return;
  }
  const items = rows
    .map(r => `<strong>${esc(PROVIDER_LABELS[r.provider] || r.provider)}</strong> (${esc(monthStrLabel(r.month))})`)
    .join(", ");
  banner.innerHTML = `⚠ Couldn't verify stored data against ${items} — the last 3 checks all failed to reach the provider. ` +
    `This doesn't mean the numbers are wrong, just unconfirmed.`;
  banner.style.display = "block";
}

// Re-syncs one month, re-checks it, then refreshes whatever's on screen —
// a single attempt per click, never an automatic retry loop. If it comes
// back clean, the next render (driven by the forced reload below) simply
// won't show that month/provider in drift anymore; if it's still drifting,
// that same reload shows the re-measured (and possibly changed) diff, which
// is the "say so plainly" the banner already does — no separate message to
// juggle once the banner's DOM has been replaced by the reload.
async function resyncMonth(month, accessToken, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Syncing…";
  try {
    const syncRes = await window.camazeFetch(`/api/costs?action=sync&month=${encodeURIComponent(month)}`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
    });
    const syncData = await syncRes.json();
    if (syncData.error) throw new Error(syncData.error);

    btn.textContent = "Checking…";
    const reconcileRes = await window.camazeFetch(`/api/costs?action=reconcile&month=${encodeURIComponent(month)}`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
    });
    const reconcileData = await reconcileRes.json();
    if (reconcileData.error) throw new Error(reconcileData.error);

    monthCache.delete(month);
    await loadDashboard(accessToken, true);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = originalText;
    alert(`Re-sync failed: ${err.message}`);
  }
}

const fmtMonthRange = (sel, daysElapsed) => {
  const label = new Date(Date.UTC(sel.year, sel.month - 1, 1))
    .toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${label} 1–${daysElapsed}`;
};

function showBudgetForm(accessToken, currentValue) {
  const el = document.getElementById("budget-content");
  el.innerHTML =
    '<form class="budget-form" id="budget-form">' +
    `<input type="number" id="budget-input" min="0" step="0.01" placeholder="500.00" value="${currentValue ?? ""}" required>` +
    '<button class="btn btn-sm" type="submit">Save</button>' +
    "</form>" +
    '<span class="stat-card-meta" data-role="budget-error"></span>';

  document.getElementById("budget-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = Number(document.getElementById("budget-input").value);
    const errorEl = document.querySelector('[data-role="budget-error"]');
    if (!Number.isFinite(value) || value < 0) {
      errorEl.textContent = "Enter a valid amount.";
      return;
    }
    window.camazeFetch("/api/budget", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ budget: value }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        loadDashboard(accessToken, true);
      })
      .catch((err) => {
        errorEl.textContent = err.message;
      });
  });
}

// Neutral below ~75% of budget, amber approaching, red at or over. No budget
// set (or budget of 0) is always neutral — there's nothing to be over.
// `amount`: forecast for the current month (a projection), or MTD for a
// past month (already the final, known total) — whichever the caller has.
function budgetStatus(amount, budget) {
  if (amount == null || budget == null || budget <= 0) return null;
  if (amount >= budget) return "danger";
  if (amount >= budget * 0.75) return "warning";
  return null;
}

function renderSummary(summary, accessToken, selectedMonth, isCurrentMonth, fromSyncCache, syncedAt) {
  const row = document.getElementById("summary-row");
  if (!summary) {
    row.style.display = "none";
    prevSummary = { mtd: null, forecast: null, budget: null };
    prevBudgetPct = null;
    return;
  }
  row.style.display = "grid";

  const { mtd, forecast, days_elapsed, budget, usageMtd, subscriptionMtd, fixedCostsMtd } = summary;

  document.getElementById("mtd-label").textContent = isCurrentMonth ? "Month to Date" : "Total";
  animateNumber(document.getElementById("mtd-value"), mtd, fmtUSD, prevSummary.mtd);
  prevSummary.mtd = mtd;
  document.getElementById("mtd-range").textContent = fmtMonthRange(selectedMonth, days_elapsed);

  // Data served from the Supabase sync cache (see api/costs.js's
  // SYNC_FRESH_MS) can be up to ~35 min old for the current month —
  // flagged here so a stale number is visibly stale rather than silently
  // wrong. Closed months are final, so this just credits when they were
  // last synced.
  // These two meta lines are conditional per month (synced-cache notice,
  // metered/fixed split) — toggled with visibility, not display, and
  // always given placeholder text when absent, so the stat-card's height
  // (and everything below the summary row) stays put as you page between
  // months instead of jumping up or down depending on which month you
  // land on.
  const syncedEl = document.getElementById("mtd-synced");
  if (fromSyncCache && syncedAt) {
    syncedEl.textContent = `synced ${fmtAgo(syncedAt)}`;
    syncedEl.style.visibility = "visible";
  } else {
    syncedEl.textContent = " ";
    syncedEl.style.visibility = "hidden";
  }

  // Metered (usage + provider-billed subscriptions) vs. manually-entered
  // fixed costs — only worth a line when there's actually a fixed-cost
  // component to distinguish from the metered total.
  const mtdSplitEl = document.getElementById("mtd-split");
  if (fixedCostsMtd > 0) {
    const metered = (usageMtd ?? 0) + (subscriptionMtd ?? 0);
    mtdSplitEl.textContent = `${fmtUSD(metered)} metered · ${fmtUSD(fixedCostsMtd)} fixed`;
    mtdSplitEl.style.visibility = "visible";
  } else {
    mtdSplitEl.textContent = " ";
    mtdSplitEl.style.visibility = "hidden";
  }

  // Forecast is null for a past month — it's already over, not a
  // projection. Budget status falls back to the known MTD/total instead.
  const status = budgetStatus(forecast ?? mtd, budget);
  const forecastEl = document.getElementById("forecast-value");
  if (forecast == null) {
    forecastEl.textContent = "—";
    prevSummary.forecast = null;
  } else {
    animateNumber(forecastEl, forecast, fmtUSD, prevSummary.forecast);
    prevSummary.forecast = forecast;
  }
  forecastEl.className = "stat-card-value" + (isCurrentMonth && status ? ` stat-${status}` : "");
  document.getElementById("forecast-meta").textContent = isCurrentMonth ? "est. month-end" : "month complete";

  const budgetContent = document.getElementById("budget-content");
  if (budget != null) {
    const pct = budget > 0 ? (mtd / budget) * 100 : 0;
    const isOver = pct > 100;
    const targetPct = Math.min(pct, 100);
    // Same width-transition approach as the breakdown bars above: start
    // from wherever the bar was last rendered (0 if there wasn't one),
    // then growBars() flips it to targetPct — so a day advance moves the
    // bar by just the incremental amount instead of regrowing from zero.
    const fromPct = prevBudgetPct ?? 0;
    const barClass = "budget-bar" + (status ? ` bar-${status}` : "") + (isOver ? " bar-over" : "");
    const pctLabel = isOver
      ? `<span class="budget-pct-over">${Math.round(pct)}% used</span>`
      : `${Math.round(pct)}% used`;
    budgetContent.innerHTML =
      `<div class="stat-card-value" id="budget-stat-value">${fmtUSD(budget)}</div>` +
      `<div class="budget-bar-track"><div class="${barClass}" data-grow="${targetPct}" style="width:${fromPct}%"></div></div>` +
      `<div class="stat-card-meta">${pctLabel} &middot; <a href="#" id="edit-budget-link">Edit</a></div>`;
    animateNumber(document.getElementById("budget-stat-value"), budget, fmtUSD, prevSummary.budget);
    prevSummary.budget = budget;
    prevBudgetPct = targetPct;
    growBars(budgetContent);
    document.getElementById("edit-budget-link").addEventListener("click", (e) => {
      e.preventDefault();
      showBudgetForm(accessToken, budget);
    });
  } else {
    budgetContent.innerHTML = '<button class="btn btn-sm" id="set-budget-btn" type="button">Set budget</button>';
    prevSummary.budget = null;
    prevBudgetPct = null;
    document.getElementById("set-budget-btn").addEventListener("click", () => {
      showBudgetForm(accessToken, null);
    });
  }
}

// Labels that only depend on which month is selected (not on fetched data)
// update immediately on month change, before the fetch even lands — no
// flash of the previous month's label while loading.
function updateMonthUI() {
  const label = monthLabel(selectedMonth);
  document.getElementById("month-label").textContent = label;
  document.getElementById("month-next").disabled = isSelectedMonthCurrent(selectedMonth);
  document.getElementById("subtitle").textContent = `AI API spend, daily, ${label} (UTC)`;
  document.getElementById("models-label").textContent = `Spend by model (${label})`;
  document.getElementById("attribution-label").textContent = `Spend by project (${label})`;
  document.getElementById("departments-label").textContent = `Spend by department (${label})`;
  document.getElementById("people-label").textContent = `Top spenders (${label})`;
}

// Fetched-month cache, keyed by "YYYY-MM" — re-selecting a month already
// viewed this session (via prev/next) renders straight from memory instead
// of round-tripping to /api/costs again. Page-lifetime only (a plain JS
// Map, not sessionStorage), so a full reload always starts fresh. Closed
// months never change, so their entries live for the page's lifetime; the
// current month is still accruing spend, so its entry expires after
// CLIENT_CACHE_TTL_MS (matching the server's own CACHE_TTL_MS in
// api/costs.js) rather than serving an increasingly stale total on a
// long-lived tab.
const monthCache = new Map(); // monthStr -> { data, fetchedAt }
const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;

function isMonthCacheFresh(key, entry) {
  if (key !== monthStr(currentMonthUTC())) return true; // closed months don't expire
  return Date.now() - entry.fetchedAt < CLIENT_CACHE_TTL_MS;
}

function applyDashboardData(data, accessToken, sel, isCurrentMonth) {
  renderDriftBanner(data.reconciliation);
  renderUnverifiableBanner(data.unverifiable);
  if (data.no_keys) {
    destroySpendChart();
    document.getElementById("chart-description").textContent = "";
    document.getElementById("content").innerHTML =
      '<div class="message">No providers connected yet. ' +
      '<a href="/integrations.html">Go to Integrations</a> to get started.</div>';
    renderModels([]);
    renderAttribution([]);
    renderDepartmentBreakdown([]);
    renderTopSpenders([]);
    renderSubscriptions([]);
    renderSummary(null);
    return;
  }
  render(data);
  renderModels(data.models);
  renderAttribution(data.attribution);
  renderDepartmentBreakdown(data.attribution);
  renderTopSpenders(data.attribution);
  renderSubscriptions(data.subscriptions, data.totals?.subscriptions);
  renderSummary(data.summary, accessToken, sel, isCurrentMonth, data.from_sync_cache, data.synced_at);
}

function showLoadError(err) {
  destroySpendChart();
  document.getElementById("chart-description").textContent = "";
  document.getElementById("content").innerHTML =
    '<div class="message">Could not load cost data: ' + esc(err.message) + "</div>";
  renderModels([]);
  renderAttribution([]);
  renderDepartmentBreakdown([]);
  renderTopSpenders([]);
  renderSubscriptions([]);
  renderSummary(null);
}

function loadDashboard(accessToken, forceRefreshOverride) {
  // Set by the Integrations page right after connecting/disconnecting a
  // provider, or by a successful budget save — bypass the cache once so
  // the change shows up immediately.
  const sessionFlag = sessionStorage.getItem("camaze_keys_changed");
  if (sessionFlag) sessionStorage.removeItem("camaze_keys_changed");
  const forceRefresh = forceRefreshOverride || !!sessionFlag;
  const sel = selectedMonth;
  const key = monthStr(sel);
  const isCurrentMonth = isSelectedMonthCurrent(sel);

  if (forceRefresh) monthCache.delete(key);

  const cached = monthCache.get(key);
  if (cached && isMonthCacheFresh(key, cached)) {
    applyDashboardData(cached.data, accessToken, sel, isCurrentMonth);
    return Promise.resolve();
  }

  const params = new URLSearchParams({ month: key });
  if (forceRefresh) params.set("refresh", "1");
  const url = "/api/costs?" + params;

  return window.camazeFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    .then(async (res) => {
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      monthCache.set(key, { data, fetchedAt: Date.now() });
      // The user may have navigated to a different month while this was in
      // flight — only render if we're still looking at the month we asked for.
      if (monthStr(selectedMonth) === key) applyDashboardData(data, accessToken, sel, isCurrentMonth);
    })
    .catch((err) => {
      if (monthStr(selectedMonth) === key) showLoadError(err);
    });
}

// Warms the cache for one month in the background, without rendering.
// Best-effort: a failed prefetch is silently dropped, since the next real
// navigation to that month just falls through to a normal fetch.
function prefetchMonth(accessToken, sel) {
  const key = monthStr(sel);
  const existing = monthCache.get(key);
  if (existing && isMonthCacheFresh(key, existing)) return;
  const params = new URLSearchParams({ month: key });
  window.camazeFetch("/api/costs?" + params, { headers: { Authorization: `Bearer ${accessToken}` } })
    .then((res) => res.json())
    .then((data) => {
      if (!data.error) monthCache.set(key, { data, fetchedAt: Date.now() });
    })
    .catch(() => {});
}

(async () => {
  const cfgRes = await window.camazeFetch("/api/config");
  const cfg = await cfgRes.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    document.getElementById("content").innerHTML =
      '<div class="message">Auth is not configured (missing SUPABASE_URL/SUPABASE_ANON_KEY).</div>';
    return;
  }

  const client = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Registered before getSession() so it catches SIGNED_IN if the OAuth/
  // magic-link exchange below fires it — that event means an actual new
  // sign-in (as opposed to INITIAL_SESSION, which fires on every page load
  // that restores a session from local storage), so it's the one place to
  // log the audit event without double-logging on every dashboard visit.
  client.auth.onAuthStateChange((event, signedInSession) => {
    if (event !== "SIGNED_IN") return;
    window.camazeFetch("/api/audit-signin", {
      method: "POST",
      headers: { Authorization: `Bearer ${signedInSession.access_token}` },
    }).catch(() => {});
  });

  // Also exchanges an OAuth code in the URL for a session, if present.
  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    window.location.replace("/login.html");
    return;
  }

  // Called by simulation.js after any sim control action (day/month/play/
  // spike/refresh — reset instead forces a full reload, since it swaps the
  // whole company out from under this page). Mirrors what a fresh page
  // load already does: re-derive the current month from the (now
  // possibly-advanced) simulated date, then re-fetch — the animated
  // renders above take care of making the change visible.
  window.camazeSimRefresh = () => {
    selectedMonth = currentMonthUTC();
    updateMonthUI();
    loadDashboard(session.access_token, true);
  };

  await window.initializeSimulation(session);
  selectedMonth = currentMonthUTC();
  document.getElementById("user-email").textContent = session.user.email ?? "";
  document.getElementById("header-right").style.visibility = "visible";
  document.getElementById("signout-btn").addEventListener("click", async () => {
    await client.auth.signOut();
    window.location.replace("/login.html");
  });

  // Delegated (not attached per-render) since renderDriftBanner rebuilds
  // #drift-banner's innerHTML wholesale on every call.
  document.getElementById("drift-banner").addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="resync-month"]');
    if (!btn) return;
    resyncMonth(btn.dataset.month, session.access_token, btn);
  });

  document.getElementById("month-prev").addEventListener("click", () => {
    selectedMonth = shiftMonth(selectedMonth, -1);
    updateMonthUI();
    loadDashboard(session.access_token);
  });
  document.getElementById("month-next").addEventListener("click", () => {
    if (isSelectedMonthCurrent(selectedMonth)) return;
    selectedMonth = shiftMonth(selectedMonth, 1);
    updateMonthUI();
    loadDashboard(session.access_token);
  });

  updateMonthUI();
  // Prefetch only fires once the current month has rendered, and only one
  // month back — it doesn't block first paint since it's just scheduling a
  // background fetch after the initial render's promise chain settles. The
  // extra ~2s delay skips the prefetch entirely for users who load the page
  // and immediately navigate away, so it only pays for itself for users
  // actually sticking around.
  loadDashboard(session.access_token).then(() => {
    const prevMonth = shiftMonth(selectedMonth, -1);
    setTimeout(() => prefetchMonth(session.access_token, prevMonth), 2000);
  });
})();
