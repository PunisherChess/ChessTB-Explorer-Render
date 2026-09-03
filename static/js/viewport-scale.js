/**
 * viewport-scale.js — Dynamic root font-size scaling for ChessTB Explorer
 *
 * Rules:
 * 1. Base font size is always 16px. It will NEVER shrink below 16px.
 * 2. Only scales UP on spacious displays (e.g. 1440p, 4K, 5K fullscreen).
 * 3. At or below the 1180px breakpoint, removes overrides and lets CSS handle mobile.
 * 4. Uses logical CSS pixels (innerWidth / innerHeight), never physical hardware pixels.
 */

(function () {
  'use strict';

  const MOBILE_BREAKPOINT_PX = 1180;

  // Baseline desktop dimensions where 1rem = 16px is exact:
  const BASELINE_WIDTH_PX = 1280;
  const BASELINE_HEIGHT_PX = 720; // Adjusted for typical browser chrome height

  const BASE_FONT_SIZE_PX = 16;
  const MAX_FONT_SIZE_PX = 20; // 1.25x maximum scale cap

  function computeScale() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    // Below or at mobile breakpoint: reset to CSS default (16px)
    if (viewportWidth <= MOBILE_BREAKPOINT_PX) {
      document.documentElement.style.fontSize = '';
      return;
    }

    // Determine scale on limiting axis:
    const scaleX = viewportWidth / BASELINE_WIDTH_PX;
    const scaleY = viewportHeight / BASELINE_HEIGHT_PX;
    const rawScale = Math.min(scaleX, scaleY);

    // If the window is at default desktop size or height-constrained,
    // lock to exact 16px baseline (never shrink below 1.0x):
    if (rawScale <= 1.0) {
      document.documentElement.style.fontSize = `${BASE_FONT_SIZE_PX}px`;
      return;
    }

    // Only scale up if there is also sufficient horizontal room:
    // (Ensures the ~63.25rem layout doesn't exceed viewport width)
    let targetFontSize = BASE_FONT_SIZE_PX * rawScale;
    const maxFontSizeForWidth = viewportWidth / 65;
    targetFontSize = Math.min(targetFontSize, maxFontSizeForWidth);

    // Clamp between 16px (1.0x) and 20px (1.25x):
    const clampedFontSize = Math.min(MAX_FONT_SIZE_PX, Math.max(BASE_FONT_SIZE_PX, targetFontSize));

    document.documentElement.style.fontSize = `${clampedFontSize.toFixed(2)}px`;
  }

  // Execute immediately before render to avoid FOUC:
  computeScale();

  // Smooth re-calculation on resize:
  let rAF = null;
  window.addEventListener('resize', function () {
    if (rAF) cancelAnimationFrame(rAF);
    rAF = requestAnimationFrame(computeScale);
  }, { passive: true });
})();