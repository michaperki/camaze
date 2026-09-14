import { animate, stagger } from 'motion';
import autoAnimate from '@formkit/auto-animate';
import { computePosition, autoUpdate, offset, flip, shift } from '@floating-ui/dom';
import confetti from 'canvas-confetti';
import '@awesome.me/webawesome';
import '@awesome.me/webawesome/dist/styles/webawesome.css';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Animate shared layout changes as pages render their cards and messages.
function observeLayout() {
  document.querySelectorAll('main, .panel-body, .sim-drawer-body').forEach(el => {
    if (!el.dataset.autoAnimated) { autoAnimate(el, { duration: reduced ? 0 : 180 }); el.dataset.autoAnimated = '1'; }
  });
}

function addTooltip(trigger) {
  const content = trigger.dataset.tooltip;
  if (!content || trigger.dataset.tooltipReady) return;
  trigger.dataset.tooltipReady = '1';
  const tip = document.createElement('wa-tooltip');
  tip.setAttribute('for', trigger.id);
  tip.textContent = content;
  trigger.parentElement?.insertBefore(tip, trigger);
}

function setup() {
  observeLayout();
  document.querySelectorAll('[data-tooltip]').forEach(addTooltip);
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

new MutationObserver(setup).observe(document.documentElement, { childList: true, subtree: true });
setup();
window.camazeCelebrate = celebrate;
