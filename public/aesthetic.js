import { animate, stagger } from 'motion';
import autoAnimate from '@formkit/auto-animate';
import { computePosition, autoUpdate, offset, flip, shift } from '@floating-ui/dom';
import confetti from 'canvas-confetti';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/styles/webawesome.css';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Animate shared layout changes as pages render their cards and messages.
function observeLayout() {
  document.querySelectorAll('main, .panel-body, .sim-drawer-body').forEach(el => {
    if (!el.dataset.autoAnimated) { autoAnimate(el, { duration: reduced ? 0 : 180 }); el.dataset.autoAnimated = '1'; }
  });
}

function addTooltip(trigger) {
  const content = trigger.getAttribute('aria-label') || trigger.dataset.tooltip;
  if (!content || trigger.dataset.tooltipReady) return;
  trigger.dataset.tooltipReady = '1';
  const tip = document.createElement('wa-tooltip');
  tip.setAttribute('for', trigger.id);
  tip.setAttribute('placement', 'top');
  tip.textContent = content;
  trigger.parentElement?.insertBefore(tip, trigger);
  trigger.addEventListener('camaze-tooltip-update', () => {
    tip.textContent = trigger.getAttribute('aria-label') || trigger.dataset.tooltip || '';
    // Keep the button's explicit, stateful aria-label as its accessible name.
    // Web Awesome adds aria-labelledby for tooltip content, but the hidden
    // tooltip can otherwise override that name in some screen readers.
    trigger.removeAttribute('aria-labelledby');
  });
  requestAnimationFrame(() => trigger.removeAttribute('aria-labelledby'));
}

function refreshTooltipText(trigger) {
  const tip = document.querySelector(`wa-tooltip[for="${CSS.escape(trigger.id)}"]`);
  if (tip) tip.textContent = trigger.getAttribute('aria-label') || trigger.dataset.tooltip || '';
}

function setup() {
  observeLayout();
  document.querySelectorAll('[data-tooltip]').forEach(addTooltip);
  document.querySelectorAll('[data-tooltip]').forEach(refreshTooltipText);
  if (!reduced) {
    document.querySelectorAll('.btn, .tabs a').forEach(el => {
      el.addEventListener('pointerenter', () => animate(el, { scale: 1.025 }, { duration: .15 }));
      el.addEventListener('pointerleave', () => animate(el, { scale: 1 }, { duration: .15 }));
    });
  }
}

export function celebrate() {
  if (reduced) return;
  confetti({ particleCount: 42, spread: 65, origin: { y: .72 }, colors: ['#00a4f4', '#4d7ea8', '#4f9e7d', '#c67c52'] });
}

// A small positioning helper for any future custom popover; using Floating UI
// here also keeps the dependency exercised for contextual UI work.
export function positionPopover(reference, floating) {
  return autoUpdate(reference, floating, async () => {
    const { x, y } = await computePosition(reference, floating, { placement: 'top', middleware: [offset(8), flip(), shift({ padding: 8 })] });
    Object.assign(floating.style, { left: `${x}px`, top: `${y}px` });
  });
}

setup();
// Pages that render sections later can call this explicitly after their
// render. A document-wide MutationObserver is deliberately avoided here:
// Web Component shadow/light-DOM lifecycle updates can otherwise create a
// feedback loop during startup.
window.camazeAestheticSetup = setup;
window.camazeCelebrate = celebrate;
