/**
 * app.js — Bootstrap
 *
 * The entry point, loaded as a module. Determines the initial position and
 * rules variant, wires up board/piece theming in the correct order,
 * initialises the UI, and listens for URL hash changes so the position
 * (and variant) stay in sync with `#fen=...&variant=chess960` links (read
 * on load; written on every position change by ui.js).
 *
 * Theme.init(Board.reconstruct) is registered BEFORE Board.init() runs,
 * because Board.init() reads Theme.pieceThemeFn() while constructing the
 * Chessboard() instance. Theme.apply() runs AFTER Board.init(), because it
 * injects a <style> tag that targets DOM nodes the board just created.
 */

import { UI }              from './ui.js';
import { Board, VARIANTS } from './board.js';
import { Theme }           from './theme.js';

(function () {

    // Default starting position for the explorer. The castling-availability
    // field is always '-': the loaded tablebases are generated on the
    // assumption that neither side retains the right to castle.
    const DEFAULT_FEN = '4k3/8/8/8/8/8/8/4K2R w - - 0 1';

    // Read position (and variant) from URL hash first (e.g. a shared link).
    // If there's no hash (e.g. we just navigated back from /admin, which has
    // no #fen= of its own and so drops it entirely), fall back to the last
    // full game (start position + move list + variant) persisted to
    // localStorage — this is what lets the board position, the PGN panel,
    // *and* the active rules variant all survive that round-trip. Falls
    // back to the hard-coded default starting position (Standard) if
    // neither is available.
    //
    // Variant is resolved here, before Board.init() ever parses initialFen
    // into the rules engine, and passed to it directly — never inferred
    // from the FEN itself (the orthodox starting array is itself a legal
    // Chess960 starting position, so the FEN alone can't disambiguate; see
    // board.js's module doc comment).
    const hashFen     = UI.readHashFen();
    const hashVariant = UI.readHashVariant();
    const lastGame    = UI.readLastGame();

    let initialFen, initialVariant, restoreGame;
    if (hashFen) {
        initialFen     = UI.normalizeFen(hashFen);
        initialVariant = hashVariant || VARIANTS.STANDARD;
        restoreGame    = null;
    } else if (lastGame) {
        initialFen     = UI.normalizeFen(lastGame.startFen);
        initialVariant = lastGame.variant;
        restoreGame    = lastGame;
    } else {
        initialFen     = DEFAULT_FEN;
        initialVariant = VARIANTS.STANDARD;
        restoreGame    = null;
    }

    // Register the piece-set reconstruction callback before Board.init()
    // creates the first Chessboard() instance.
    Theme.init(Board.reconstruct);

    document.addEventListener('DOMContentLoaded', () => {
        UI.init(initialFen, restoreGame, initialVariant);

        // Apply the (fixed) board/piece-set theme and inject the theme
        // <style> tag. Runs after UI.init() (which calls Board.init())
        // because the injected CSS targets board DOM nodes that must
        // already exist.
        Theme.apply();
    });

    // Also support hash changes (browser back/forward, shared links opened while tab is open).
    // Goes through Board.setPositionAndVariant() — not calling ui.js's internal
    // onPositionChange() directly, and not Board.setVariant()+setPosition() separately, since
    // that would validate the incoming FEN against whichever variant is *currently* active on
    // its way to the one the link actually specifies (see board.js's setVariant() doc comment) —
    // so the visible board, the chessops position, and the move tree all move with the hash
    // instead of only the FEN box/results panel updating. Invokes onPositionChange() itself.
    window.addEventListener('hashchange', () => {
        const newFen = UI.readHashFen();
        if (!newFen) return;
        const newVariant = UI.readHashVariant() || VARIANTS.STANDARD;
        const result = Board.setPositionAndVariant(UI.normalizeFen(newFen), newVariant);
        if (!result.ok) UI.toast(result.reason || 'Invalid position in URL.');
    });

}());
