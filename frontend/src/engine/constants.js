/**
 * constants.js: values shared across engine modules and components (no imports).
 */

// The application's rules-mode state (Standard / Chess960).
export const VARIANTS = Object.freeze({ STANDARD: 'standard', CHESS960: 'chess960' });

// parentId / currentId of the position before any move in a move tree.
export const ROOT_ID = -1;

// Metric ids in table order, with their response keys.
export const METRICS = {
    dtz:   { label: 'DTZ',   dataKey: 'moves_dtz',   availableKey: 'dtz_available'   },
    dtc:   { label: 'DTC',   dataKey: 'moves_dtc',   availableKey: 'dtc_available'   },
    dtm:   { label: 'DTM',   dataKey: 'moves_dtm',   availableKey: 'dtm_available'   },
    dtm50: { label: 'DTM50', dataKey: 'moves_dtm50', availableKey: 'dtm50_available' },
};

// localStorage keys.
export const STORAGE_KEYS = Object.freeze({
    ORIENTATION:  'chesstb_orientation',
    LOCKED:       'chesstb_locked',
    LAST_GAME:    'chesstb_last_game',
    SHOW_ROOT_ROW: 'chesstb_show_root_row',
    AUTOPLAY_DELAY_MS: 'chesstb_autoplay_delay_ms',
});

// Auto-play pacing (Settings → Autoplay Delay).
export const AUTOPLAY_DELAY = Object.freeze({
    MIN_MS: 0,
    MAX_MS: 2500,
    STEP_MS: 50,
    DEFAULT_MS: 1250,
});

export function formatAutoPlayDelay(ms) {
    return ms === 0 ? '0s' : `${parseFloat((ms / 1000).toFixed(2))}s`;
}
