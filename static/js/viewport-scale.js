/* Sets the responsive root font-size for the board/explorer layout (see
   main.css's "Reset" section and the --board-size custom property comment).
   Only takes effect above the 1180px mobile/tablet breakpoint that main.css's
   own "Responsive layout" media query already switches on — at or below that
   width this deliberately forces the same fixed 16px baseline the
   mobile/tablet/phone layout uses, so that layout is provably unaffected
   by this script. Above it, the root font-size (and therefore every
   rem-based measurement on the page, including --board-size) scales
   against the design's baseline: a 1920x1080 physical monitor at 125%
   OS display scaling, which browsers report as a 1536x864 CSS-pixel
   screen — min(screen.width / 1536, screen.height / 864). screen.width/
   height are already logical/CSS pixels, not raw physical pixels: on
   Windows they reflect the chosen display-scaling percentage, and on
   macOS a Retina/HiDPI panel reports its logical (points) resolution —
   e.g. a 5120x2880 5K display in its default 2x HiDPI mode reports
   2560x1440 — rather than its physical pixel count. Comparing these
   logical values directly, with no devicePixelRatio factor, is what
   makes the scale consistent across displays regardless of pixel
   density: a standard-density 2560x1440 monitor and a 5120x2880 Retina
   display in 2x HiDPI mode both present a 2560x1440 CSS-pixel screen and
   so get the same root font-size, with devicePixelRatio then governing
   only how many physical dots render each logical pixel (i.e. sharpness,
   not size). The 1180px breakpoint check above is deliberately left in
   raw CSS pixels to match main.css's own viewport-width media query. The
   result is floored at the 1280x720 minimum supported resolution's ratio
   so nothing renders smaller than that, and left with no upper limit, so
   higher resolutions (2K, 4K, ultrawide, ...) scale up freely. A CSS
   transform: scale() is deliberately not used here — it would
   double-scale chessground's own pixel math, which reads the
   already-transformed getBoundingClientRect() of its container and
   re-applies that as a further transform on each piece; a genuine
   font-size/layout change is what lets chessground's own ResizeObserver
   see the real resize and lay itself out correctly. Resize handling is
   coalesced to one recalculation per animation frame, since a raw 'resize'
   listener can fire many times per frame while a window is actively being
   dragged. Moving the window to a different display doesn't reliably fire
   'resize' even though screen.width/height (and so the correct scale) may
   have changed, so a change in devicePixelRatio — watched via a matchMedia
   resolution query — is used as a proxy signal to recheck.

   Loaded as a plain same-origin <script src> (not inlined in index.html)
   because this app's Content-Security-Policy sends `script-src 'self'`
   with no 'unsafe-inline' and no nonce (see app.py's set_security_headers)
   — an inline <script> block is silently blocked by the browser under that
   policy and never runs. Referenced as a normal blocking, non-module,
   non-async/defer script tag placed before the stylesheet <link> tags in
   <head>, so — same as an inline script would — it still executes and sets
   the correct font-size before the stylesheets are applied and before first
   paint, avoiding a flash of incorrectly-scaled content. */
(function () {
  // Must match main.css's `@media (max-width: 1180px)` breakpoint exactly —
  // below/at this width the layout switches to the wrapping/scrolling
  // mobile+tablet system, which is authored in fixed px and must never see
  // a root font-size other than 16px.
  var MOBILE_BREAKPOINT_PX = 1180;
  // Logical (CSS-pixel) screen resolution of the design's reference
  // configuration: a 1920x1080 physical monitor at 125% OS display scaling.
  var BASELINE_W = 1536, BASELINE_H = 864;
  // 1280x720 is the minimum *supported* resolution, at 100% OS display
  // scaling (so logical == physical here). Both axes share the baseline's
  // 16:9 ratio, so this single number floors both.
  var FLOOR_SCALE = Math.min(1280 / BASELINE_W, 720 / BASELINE_H);
  var rafId = null;

  function applyScale() {
    rafId = null;
    if (window.innerWidth <= MOBILE_BREAKPOINT_PX) {
      // Mobile/tablet: always the untouched, unscaled baseline.
      document.documentElement.style.fontSize = '16px';
      return;
    }
    // Use screen.width/height — the display's own resolution — rather than
    // innerWidth/innerHeight. innerWidth/innerHeight measure the page's
    // content area *after* browser chrome (tabs, toolbar) and any OS
    // taskbar have already been subtracted from the window, so comparing
    // them against the baseline yields a ratio below 1 in ordinary
    // windowed browsing (chrome height alone is ~80-90 CSS px, an 8-12%
    // shrink at 1080p) — that's what would make the whole UI render
    // smaller than intended by default. screen.width/height report the
    // display's own resolution regardless of window size or chrome, so
    // scale=1 (16px) is reached whenever the display truly matches the
    // baseline, independent of how much of it the browser window
    // currently occupies.
    //
    // This is a deliberate choice, not an oversight: innerWidth/innerHeight
    // is a real, valid alternative — it would shrink the UI to match a
    // smaller, non-maximized browser window rather than keeping it pinned
    // to the display's size — but the two are mutually exclusive, and the
    // requirement here is that the UI holds its intended on-screen size for
    // a given display regardless of how much screen real estate the
    // browser window currently occupies. Don't switch this to
    // innerWidth/innerHeight without re-confirming that requirement.
    var raw = Math.min(window.screen.width / BASELINE_W, window.screen.height / BASELINE_H);
    var scale = Math.max(raw, FLOOR_SCALE);   // floor at 1280x720; no ceiling
    document.documentElement.style.fontSize = (16 * scale) + 'px';
  }
  function onResize() {
    if (rafId === null) rafId = window.requestAnimationFrame(applyScale);
  }
  function watchDpr() {
    var mq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
    mq.addEventListener('change', function () {
      applyScale();
      watchDpr();
    });
  }
  applyScale();
  window.addEventListener('resize', onResize);
  watchDpr();
}());
