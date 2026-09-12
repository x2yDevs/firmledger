/* FirmLedger — Leads inbox: cut the list frame and the conversation card to
   the window that is actually drawing them.
   Desktop only (min-width: 901px — the same breakpoint as the sticky panes).

   Why this exists: the stylesheet sizes both panes with a window formula
   (--pane-h) that subtracts a fixed estimate of the head above them. Once the
   breadcrumb head, the filter tabs, the "waiting for your reply" line and the
   listing picker are actually drawn, the slot starts lower than the estimate,
   and the card can also be pushed taller by its own content because its
   height is `auto` with only a floor. Result at rest: the inbox pager and the
   conversation composer ended up below the fold, and on short windows most of
   the fixed foot was off screen.

   This script measures the real .lead-layout slot and hands the visible
   column an exact, viewport-derived --lead-fit-h (set as a custom property,
   never as an inline dimension, so every stylesheet rule and the pane resize
   script keeps working). The internal list/thread already scroll on their
   own, so every control above and below them stays on screen. At and below
   900px wide the pages stack and the document itself scrolls — there the
   variable is removed and nothing is capped. */
(function () {
  'use strict';

  var DESKTOP = '(min-width: 901px)';
  var mq = window.matchMedia ? window.matchMedia(DESKTOP) : null;

  /* Section bottom padding (1.5rem) plus a breath of air. */
  var BOTTOM_GAP = 12;
  /* A frame shorter than these is not a frame — leave the page natural. The
     pane floor is the short-window chrome (head, facts, pinned foot) plus the
     96px chat floor; below it the composer cannot fit no matter what. */
  var LIST_FLOOR = 220;
  var PANE_FLOOR = 340;

  function desktop() {
    if (mq) return mq.matches;
    return (window.innerWidth || 0) >= 901;
  }

  function fit() {
    var layout = document.querySelector('.leads-section .lead-layout');
    if (!layout) return;
    var listCol = document.querySelector('.leads-section .lead-list-col');
    var pane = document.querySelector('.lead-detail-col .lead-detail');

    if (!desktop()) {
      /* Stacked screens: hand all sizing back to the stylesheet. */
      if (listCol && listCol.style) listCol.style.removeProperty('--lead-fit-h');
      if (pane && pane.style) pane.style.removeProperty('--lead-fit-h');
      return;
    }

    /* The grid wrapper never moves (only the sticky column inside it does),
       so its document position is the real top of the slot — head, tabs,
       waiting line and alerts all already accounted for. */
    var rect = layout.getBoundingClientRect();
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var slotTop = rect.top + scrollY;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var h = Math.round(vh - slotTop - BOTTOM_GAP);

    if (listCol && listCol.style) {
      if (h >= LIST_FLOOR) listCol.style.setProperty('--lead-fit-h', h + 'px');
      else listCol.style.removeProperty('--lead-fit-h');
    }
    if (pane && pane.style) {
      if (h >= PANE_FLOOR) pane.style.setProperty('--lead-fit-h', h + 'px');
      else pane.style.removeProperty('--lead-fit-h');
    }
  }

  var ticking = false;
  function requestFit() {
    if (ticking) return;
    ticking = true;
    (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () {
      ticking = false;
      fit();
    });
  }

  window.addEventListener('resize', requestFit, { passive: true });
  window.addEventListener('orientationchange', requestFit, { passive: true });
  /* A reply changes the head (the waiting line can appear or disappear), and
     tabs can wrap after fonts arrive — re-measure on load and once fonts are
     ready, and watch the head for any size change afterwards. */
  window.addEventListener('load', requestFit, { passive: true });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(requestFit).catch(function () {});
  }
  if (typeof ResizeObserver !== 'undefined') {
    /* The head is its own section above the list, so watching it can never
       loop on a pane resize — it only fires when the chrome reflows. */
    var head = document.querySelector('.leads-head');
    if (head) new ResizeObserver(requestFit).observe(head);
  }

  fit();

  /* Test seam: the floors and the gap are the geometry contract. */
  window.__flLeadsFit = {
    fit: fit,
    gap: BOTTOM_GAP,
    listFloor: LIST_FLOOR,
    paneFloor: PANE_FLOOR,
  };
})();
