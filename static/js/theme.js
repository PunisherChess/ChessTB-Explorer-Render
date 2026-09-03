/**
 * theme.js — Board and piece theming module
 *
 * Owns the chess board's visual styling: square colours, rank/file label
 * colours, last-move highlight colour, spare-piece tray colours, and the
 * piece-set image path. This build fixes the board to Libre Brown and the
 * piece set to CBurnett — there is no picker and no persisted choice.
 * Exposes a small public API consumed by board.js and app.js.
 *
 * The CSS-generation function below targets chessground's DOM/class model
 * (`cg-board`, `coords.ranks`/`coords.files`) — see the comment above
 * _coordLabelCss() for how coordinate-label positioning and colouring are
 * derived against that model.
 *
 * Public API:
 *   Theme.init(reconstructBoard)   — register board reconstruction callback
 *   Theme.apply()                  — inject the board's theme <style> tag
 *   Theme.currentPieceSet()        — return the active piece set id string
 *   Theme.pieceThemeFn()           — return piece-code → image-path function
 *                                     (used by board.js's spare trays and
 *                                     promotion dialog)
 */

// Values match main.css's own square-colour defaults, so the board renders
// identically whether or not this module has run yet.
const BOARD = {
    id:          'libre-brown',
    lightSquare: '#f0d9b5',
    darkSquare:  '#b58863',
    labelLight:  '#b58863',   // label colour on light-square corners
    labelDark:   '#f0d9b5',   // label colour on dark-square corners
    highlight:   'rgba(155, 199, 0, 0.41)',
    trayBg:      '#b0a998',
    trayBgDark:  '#726a5a',
    trayBorder:  '#8a8070',
};

const PIECE_SET = 'cburnett';

let _reconstructBoard = null;  // callback registered via init()

// ── Private: CSS generation ───────────────────────────────────────────────
//
// Chessground has no per-square light/dark CSS classes — the checkerboard
// pattern is a single background-image on `cg-board`. It is rendered here
// as a tiny tiled SVG data URI (_checkerboardDataUri) rather than
// replicating chessground's own base64/opacity-overlay technique — same
// visual result, easier to template and to review in a diff. Rank/file
// labels are chessground's own `coords.ranks`/`coords.files` elements,
// positioned by static CSS in main.css to sit inset at the board's corners
// rather than chessground's default outside-the-board placement. Colour is
// done with :nth-child selectors scoped by orientation, NOT the
// `.coord-light`/`.coord-dark` classes renderCoords() (wrap.ts) puts on
// each label — verified against a live render that those classes don't
// correspond to the actual square each label overlays once repositioned
// this way (chessground's own official theme CSS doesn't use them for
// coords.ranks/coords.files either, for the same reason: they're only
// meaningful for chessground's default outside-the-board placement, not an
// overlaid one). See the matching comment in main.css for the full
// derivation.

function _checkerboardDataUri(light, dark) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'>
<rect width='1' height='1' fill='${light}'/>
<rect x='1' width='1' height='1' fill='${dark}'/>
<rect y='1' width='1' height='1' fill='${dark}'/>
<rect x='1' y='1' width='1' height='1' fill='${light}'/>
</svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// A light-square label gets c.labelLight, a dark-square label gets
// c.labelDark. class + type + type + :nth-child, matched on all four
// orientation/parity combinations, carries the specificity needed to
// override main.css's own default coord-label rule (see the comment there
// for why .coord-light/.coord-dark aren't used) regardless of source
// order. For white orientation the odd nth-child positions land on the
// a-file's dark squares (a1/a3/a5/a7, per main.css's comment) and so take
// c.labelDark; the even positions (a2/a4/a6/a8, light squares) take
// c.labelLight. No text-shadow: the label colour itself carries enough
// contrast against its own square.
function _coordLabelCss(c) {
    return `.orientation-white coords.ranks coord:nth-child(odd),
.orientation-white coords.files coord:nth-child(odd) { color: ${c.labelDark} !important; }
.orientation-white coords.ranks coord:nth-child(even),
.orientation-white coords.files coord:nth-child(even) { color: ${c.labelLight} !important; }
.orientation-black coords.ranks coord:nth-child(odd),
.orientation-black coords.files coord:nth-child(odd) { color: ${c.labelLight} !important; }
.orientation-black coords.ranks coord:nth-child(even),
.orientation-black coords.files coord:nth-child(even) { color: ${c.labelDark} !important; }`;
}

function _cssForBoard(c) {
    return `/* chesstb-theme: ${c.id} */
:root { --tray-bg: ${c.trayBg}; --tray-bg-dark: ${c.trayBgDark}; --tray-border: ${c.trayBorder}; }
cg-board {
    background-image: url("${_checkerboardDataUri(c.lightSquare, c.darkSquare)}");
    /* _checkerboardDataUri() returns a 2x2 tile (2 squares per axis).
       25% 25% sizes it to 2/8 of the board per axis, so the tile repeats
       4x4 (background-repeat's default) to fill all 64 squares; matches
       the base checkerboard sizing in main.css. */
    background-size: 25% 25%;
}
${_coordLabelCss(c)}
cg-board square.last-move { background-color: ${c.highlight} !important; }`;
}

function _applyCSS() {
    let tag = document.getElementById('chesstb-theme');
    if (!tag) {
        tag = document.createElement('style');
        tag.id = 'chesstb-theme';
        document.head.appendChild(tag);
    }
    tag.textContent = _cssForBoard(BOARD);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Register the board reconstruction callback from board.js.
 * Must be called before Board.init().
 */
function init(reconstructBoard) {
    _reconstructBoard = reconstructBoard;
}

/**
 * Inject the board's theme <style> tag and populate the piece-set-dependent
 * tray/promotion images.
 */
function apply() {
    _applyCSS();
    if (_reconstructBoard) {
        _reconstructBoard(pieceThemeFn());
    }
}

/** Return the active piece set id string. */
function currentPieceSet() { return PIECE_SET; }

/**
 * Return the piece-code → image-path function for the active piece set
 * (e.g. 'wQ' -> '/static/pieces/cburnett/wQ.svg'). Called by board.js to
 * populate the spare-tray and promotion-dialog images.
 */
function pieceThemeFn() {
    return function (piece) {
        return `/static/pieces/${PIECE_SET}/${piece}.svg`;
    };
}

export const Theme = {
    init, apply,
    currentPieceSet,
    pieceThemeFn,
};
