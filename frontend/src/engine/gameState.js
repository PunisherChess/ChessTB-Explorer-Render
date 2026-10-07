/**
 * gameState.js: URL-hash sharing and persisted game state
 *
 * The hash is rewritten on every position change so the address bar stays
 * share-able, and is read back on load (and on hashchange) to restore a
 * shared link. Persisting the full move tree to localStorage additionally
 * lets a round-trip through a different route (e.g. /admin, which has no
 * #fen= of its own) restore the board position and PGN panel together.
 */

import { VARIANTS } from './board.js';
import * as Storage from './storage.js';

export function writeHash(fen, variant) {
    try {
        let hash = '#fen=' + encodeURIComponent(fen);
        if (variant === VARIANTS.CHESS960) hash += '&variant=' + VARIANTS.CHESS960;
        history.replaceState(null, '', hash);
    } catch { /* sandboxed context */ }
}

export function readHashFen() {
    try {
        const m = location.hash.match(/[#&]fen=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
}

// Returns VARIANTS.CHESS960 / VARIANTS.STANDARD, or null (Standard) if the
// hash has no (or an unrecognized) variant param. Never inferred from the
// FEN itself.
export function readHashVariant() {
    try {
        const m = location.hash.match(/[#&]variant=([^&]+)/);
        if (!m) return null;
        const v = decodeURIComponent(m[1]);
        if (v === VARIANTS.CHESS960) return VARIANTS.CHESS960;
        if (v === VARIANTS.STANDARD) return VARIANTS.STANDARD;
        return null;
    } catch { return null; }
}

const _LS_GAME = 'chesstb_last_game';

export function saveGameState(history, startFen, variant) {
    Storage.writeJson(_LS_GAME, {
        variant,
        startFen,
        nodes:           history.nodes,
        rootChildren:    history.rootChildren,
        rootActiveChild: history.rootActiveChild,
        currentId:       history.currentId,
    });
}

export function readLastGame() {
    const parsed = Storage.readJson(_LS_GAME);
    if (!parsed || typeof parsed.startFen !== 'string' || !Array.isArray(parsed.nodes)) {
        return null;
    }
    parsed.variant = parsed.variant === VARIANTS.CHESS960 ? VARIANTS.CHESS960 : VARIANTS.STANDARD;
    const node = parsed.nodes[parsed.currentId];
    parsed.currentFen = (!node || typeof node.fen !== 'string') ? parsed.startFen : node.fen;
    return parsed;
}

// Client-side mirror of the backend's own FEN padding (app.py's
// _normalize_fen): pads a partial FEN out to all six fields with the
// standard defaults.
export function normalizeFen(s) {
    const trimmed = s.trim();
    const defaults = ['8/8/8/8/8/8/8/8', 'w', '-', '-', '0', '1'];
    const parts = trimmed ? trimmed.split(/\s+/) : [];
    while (parts.length < 6) parts.push(defaults[parts.length]);
    return parts.slice(0, 6).join(' ');
}
