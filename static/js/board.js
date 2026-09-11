/**
 * board.js — Chessground wrapper
 *
 * Wraps the vendor Chessground() instance and a chessops position, and owns:
 *   - A branching move tree (_nodes/_rootChildren) used by the PGN panel:
 *     playing a move after navigating back adds a variation instead of
 *     overwriting the continuation from that point. A plain
 *     undo/redo FEN stack (_history/_future) sits alongside it as a
 *     fallback for Back/Forward once navigation walks off the tree (e.g.
 *     past a board edit that started a fresh one).
 *   - Best-move arrows for DTZ/DTM/DTM50, drawn via chessground's native
 *     drawable.autoShapes.
 *   - Click-to-place editing: click a spare piece, then click a square to
 *     place it. Drag-from-tray is also supported (chessground's
 *     dragNewPiece()).
 *   - goToNode() — jump to any node in the *current* move tree (used by
 *     the PGN panel, including variation moves) without resetting the tree
 *     or re-triggering a probe for a position that's already been evaluated.
 *   - Board/piece theming: the piece image path is owned by theme.js
 *     (Theme.pieceThemeFn()). reconstruct(pieceThemeFn) updates the piece
 *     CSS <link> and repopulates the spare-tray/promotion-dialog images;
 *     chessground never needs to be destroyed and rebuilt for a piece-set
 *     change, since piece images are plain CSS.
 *   - The active rules variant (Standard / Chess960) and the FEN protocol
 *     boundary between them. chessops's own `Chess` class implements both
 *     rulesets' move generation/legality/SAN identically and has no
 *     variant concept of its own — castling legality, paths, and rook
 *     squares are computed the same way regardless of variant (see
 *     chessgroundDests() below for the one place chessops *is* told which
 *     variant is active, purely to choose which destinations chessground
 *     is offered). But the *application's* Standard-vs-Chess960 FEN
 *     contract is not the same as chessops's generic one: chessops's own
 *     FEN parser resolves a 'K'/'Q'/'k'/'q' castling letter to whichever
 *     rook sits on the correct side of the king wherever the king happens
 *     to be (needed for Chess960, where the king isn't always on the
 *     e-file) and also accepts Shredder-FEN/X-FEN rook-file letters
 *     unconditionally — neither of which is a legal Standard-chess
 *     castling encoding. Left unguarded, that lets the frontend silently
 *     accept a FEN in Standard mode that the backend (which does enforce
 *     this — see app.py's _validate_fen_format and python-chess's own
 *     chess960=False castling validation) would then reject. _buildPosition()
 *     below is the single place this gap is closed: it enforces the
 *     application's own Standard-mode castling contract (only 'K'/'Q'/'k'/'q',
 *     each requiring the king on its e1/e8 home square and the resolved
 *     rook on its exact a1/h1/a8/h8 home square) before ever trusting
 *     chessops's more permissive parse, so the two layers never disagree
 *     about whether a given FEN is valid for the active variant.
 *
 * Every position-changing action — setPosition(), clear(), playMove(),
 * goBack()/goForward(), board edits (off-board drop, board-setup drag,
 * click-to-place), setVariant() — records itself (in the tree or the
 * undo/redo stack, whichever applies) and invokes the onPositionChange
 * callback itself, so callers never need to remember to do either one
 * manually.
 *
 * The chessops position (_position) remains the single source of truth for
 * position/legality — chessground is a dumb, controlled rendering surface.
 * Every position-changing function ends with a call to _syncChessground(),
 * which pushes _position's current FEN (plus turn colour, check state, and
 * last-move squares) into chessground in one shot. The core mutation
 * handler (_handleBoardMutation) is written to be idempotent rather than
 * tracking which of chessground's several event hooks handled a given user
 * action, because chessground fires multiple, differently-scoped events for
 * what is logically one move — see the comment above events.move's wiring
 * in init() for the actual firing order this relies on: for an ordinary
 * relocation, chessground's own events.move fires first, then
 * events.change, then movable.events.after (confirmed directly from
 * chessground's source, not a timing flake — see board.ts's
 * baseMove()/userMove()). events.change carries no orig/dest, so if it won
 * the idempotency race it would take the generic "board edit" branch and
 * leave movable.events.after's orig/dest with nothing left to act on.
 * Wiring events.move as the primary handler avoids that: it fires before
 * events.change and, unlike movable.events.after, carries orig/dest (plus
 * capture info), so it reliably wins the idempotency race with enough
 * information to classify the move correctly. events.change and
 * movable.events.after stay wired as idempotent fallbacks, since neither
 * can fire before events.move for a relocation, and events.change remains
 * the only hook that fires at all for an off-board deletion (drag.ts's
 * deleteOnDropOff branch calls it directly, with no accompanying
 * events.move/movable.events.after).
 */

import { Chessground } from '../vendor/chessground.min.js';
import { Theme }       from './theme.js';

import { Chess, Castles, castlingSide } from '../vendor/chessops/chess.js';
import { parseFen, makeFen }       from '../vendor/chessops/fen.js';
import { chessgroundDests }        from '../vendor/chessops/compat.js';
import { parseSan, makeSan }       from '../vendor/chessops/san.js';
import { parseSquare, makeSquare } from '../vendor/chessops/util.js';

// ── Variant ──────────────────────────────────────────────────────────────
// The application's rules-mode state. Distinct from chessops's own `rules`
// property (always 'chess' for both Standard and Chess960 — see the
// module doc comment above): this is application metadata that travels
// alongside the position, never derived from it.
const VARIANTS = Object.freeze({ STANDARD: 'standard', CHESS960: 'chess960' });

const Board = (() => {

    let cg     = null;   // Chessground instance
    let _position = null;   // chessops Chess position — see module doc comment
    let _variant  = VARIANTS.STANDARD;
    let _onPositionChange    = null;
    let _onMoveHistoryChange = null;

    let _pendingPromotion = null;

    // ── Lock mode ────────────────────────────────────────────────────────────
    // When true, the board only accepts legal moves for the side to move;
    // spare-piece placement and off-board deletion are disabled. Toggled via
    // setLocked(). Moves played through the ranked-moves table, auto-play, or
    // the PGN panel are unaffected, since those are already always legal.
    let _locked = false;

    // [orig, dest] of the most recently played/navigated-to move, or
    // undefined. Fed into chessground's `lastMove` config on every sync.
    // Tracked separately from the move tree because Back/Forward/goToNode
    // land on a node that already has its own from/to squares recorded —
    // this variable is what lets _syncChessground() highlight the right
    // squares for those navigations too, not just for a freshly played move.
    let _lastMoveKeys = undefined;

    // ── Undo / redo stacks ────────────────────────────────────────────────────
    // Plain chronological FEN log, used only as a Back/Forward fallback once
    // navigation walks off the current move tree entirely (e.g. past a board
    // edit — edits aren't part of the tree, see _resetMoveLine below). While
    // the current position is inside the tree, goBack()/goForward() use the
    // tree's parent/activeChild pointers instead (see below).
    let _history = [];
    let _future  = [];
    const _MAX_HISTORY = 100;

    function _pushHistory(fen) {
        _history.push(fen);
        if (_history.length > _MAX_HISTORY) _history.shift();
        _future = [];   // any new position discards the redo stack
    }

    // ── Move tree ──────────────────────────────────────────────────────────────
    // Only legal moves via playMove() (and the promotion/drag-move
    // equivalents) are recorded here. setPosition() / clear() / board edits /
    // setVariant() reset the tree.
    //
    // Each node is {id, san, fen, from, to, parentId, children, activeChild}.
    // `id` is also the node's index in _nodes. parentId === ROOT (-1) means
    // the node replies to the tree's start position (_startFen). `children`
    // lists every move tried from that node — children[0] renders as the
    // "main" continuation, children[1+] as parenthesised variations.
    // `activeChild` is whichever child Forward should follow from that node
    // (whichever branch was most recently played/clicked into) — not
    // necessarily children[0]. `from`/`to` are the move's origin/destination
    // squares exactly as played (for a Chess960 castle, the king's origin
    // and whichever destination square chessground/chessops reported —
    // never assumed to be a fixed c/g-file square), recorded alongside
    // san/fen so lastMove highlighting works when navigating the tree, not
    // just on a freshly-played move.
    //
    // The PGN panel and PGN export walk this tree recursively so alternate
    // moves are preserved as variations instead of overwriting history.
    const ROOT = -1;

    let _nodes           = [];   // [{id, san, fen, from, to, parentId, children:[], activeChild}]
    let _rootChildren    = [];   // ids of moves played directly from _startFen
    let _rootActiveChild = null;
    let _currentId        = ROOT; // id of the node currently shown, or ROOT for _startFen itself
    let _startFen         = null; // FEN the current tree began from (for PGN formatting)

    function _childrenOf(id) { return id === ROOT ? _rootChildren : _nodes[id].children; }
    function _activeChildOf(id) { return id === ROOT ? _rootActiveChild : _nodes[id].activeChild; }
    function _setActiveChild(id, childId) {
        if (id === ROOT) _rootActiveChild = childId;
        else _nodes[id].activeChild = childId;
    }

    function _resetMoveLine() {
        _nodes            = [];
        _rootChildren     = [];
        _rootActiveChild  = null;
        _currentId        = ROOT;
        _future           = [];
        _startFen         = _position ? currentFen() : null;
        if (_onMoveHistoryChange) _emitHistory();
    }

    function _emitHistory() {
        if (_onMoveHistoryChange) {
            _onMoveHistoryChange({
                nodes: _nodes, rootChildren: _rootChildren,
                rootActiveChild: _rootActiveChild, currentId: _currentId,
            }, _startFen);
        }
    }

    // Records a played move as a child of the current node. If the current
    // node already has a child with this exact SAN (the user replayed a move
    // already tried from this point), that existing node is reused instead
    // of creating a duplicate. Otherwise a new node is created and appended
    // to the END of the children list, so an already-explored continuation
    // stays the main line and the newly-played move is recorded as a
    // parenthesised variation.
    function _addMove(san, fen, from, to) {
        _future = [];   // starting a fresh line invalidates any pre-tree redo
        const kids = _childrenOf(_currentId);
        let childId = kids.find(id => _nodes[id].san === san);
        if (childId === undefined) {
            childId = _nodes.length;
            _nodes.push({ id: childId, san, fen, from, to, parentId: _currentId, children: [], activeChild: null });
            kids.push(childId);
        }
        // (else: reused an existing child — same SAN replayed from this node)
        _setActiveChild(_currentId, childId);
        _currentId = childId;
        return childId;
    }

    // ── Piece theme ───────────────────────────────────────────────────────────
    // Delegates to theme.js, which owns the active piece set. Kept as a local
    // wrapper (rather than calling Theme.pieceThemeFn() inline everywhere)
    // so callers below don't need to know theme.js exists.
    function _pieceTheme(piece) {
        return Theme.pieceThemeFn()(piece);
    }

    // ── chessops adapter ─────────────────────────────────────────────────────
    // Small translation layer between this file's FEN-string/algebraic-key
    // vocabulary and chessops's Setup/Position/numeric-square vocabulary.
    // Contains no chess rules of its own — every legality, castling, and
    // check/mate determination below is delegated to chessops.

    function currentFen() { return makeFen(_position.toSetup()); }
    function _turnChar(pos) { return pos.turn === 'white' ? 'w' : 'b'; }

    function _fenErrorMessage(err) {
        switch (err && err.message) {
            case 'ERR_CASTLING':
                return "Invalid castling availability: expected some combination of 'K', 'Q', 'k', 'q', rook-file letters 'a'-'h'/'A'-'H', or '-'.";
            case 'ERR_TURN':      return 'Invalid FEN: side to move must be "w" or "b".';
            case 'ERR_EP_SQUARE': return 'Invalid FEN: en passant target square is not valid.';
            case 'ERR_HALFMOVES': return 'Invalid FEN: halfmove clock is not valid.';
            case 'ERR_FULLMOVES': return 'Invalid FEN: fullmove number is not valid.';
            case 'ERR_BOARD':     return 'Invalid FEN: board part is not valid.';
            default:               return 'Invalid FEN: position violates chess rules.';
        }
    }
    function _positionErrorMessage(err) {
        switch (err && err.message) {
            case 'ERR_KINGS':            return 'Position must have exactly one king per side.';
            case 'ERR_OPPOSITE_CHECK':   return 'Invalid position: the side not to move is already in check.';
            case 'ERR_PAWNS_ON_BACKRANK': return 'Invalid position: a pawn is on the back rank.';
            case 'ERR_EMPTY':            return 'Position has no pieces.';
            default:                      return 'Invalid FEN: position violates chess rules.';
        }
    }

    // A castling-availability letter with no matching king/rook pair on the
    // board (e.g. "K" with no white king and rook on their home squares) is
    // syntactically valid but not a legal right — chessops's own parser
    // silently drops it rather than rejecting the FEN (see parseCastlingFen
    // in fen.js), so that has to be checked here by comparing what was
    // requested against what the constructed position actually granted.
    // This works the same way for Standard 'KQkq' and Chess960 file-letter
    // rights, since both are resolved by chessops before this comparison —
    // no Standard-only assumption is made about which squares are valid.
    function _missingCastlingRights(setup, pos) {
        const missing = [];
        for (const square of setup.castlingRights) {
            if (!pos.castles.castlingRights.has(square)) missing.push(makeSquare(square));
        }
        return missing;
    }

    // Standard chess's castling letters mean something fixed: 'K'/'Q' is
    // the White rook on h1/a1, with the White king on e1 — never "whichever
    // rook is right/left of the king" (chessops's own, Chess960-capable,
    // resolution rule; see the module doc comment). A right that chessops
    // resolves to any other square is a Chess960-only reading of the same
    // letter and must be rejected here, in Standard mode, even though
    // chessops itself parsed it without complaint. Chess960 mode has no
    // "home square" of its own — any resolved king/rook pair is
    // acceptable there, which _missingCastlingRights above already covers.
    const _HOME_SQUARES = {
        white: { king: parseSquare('e1'), rook: { a: parseSquare('a1'), h: parseSquare('h1') } },
        black: { king: parseSquare('e8'), rook: { a: parseSquare('a8'), h: parseSquare('h8') } },
    };
    function _nonOrthodoxCastlingRights(pos) {
        const offending = [];
        for (const color of ['white', 'black']) {
            const kingSquare = pos.board.kingOf(color);
            for (const side of ['a', 'h']) {
                const rookSquare = pos.castles.rook[color][side];
                if (rookSquare === undefined) continue;
                if (kingSquare !== _HOME_SQUARES[color].king || rookSquare !== _HOME_SQUARES[color].rook[side]) {
                    offending.push(makeSquare(rookSquare));
                }
            }
        }
        return offending;
    }

    // Standard mode accepts only 'K'/'Q'/'k'/'q' (each optional, in that
    // order) or '-'; Chess960 additionally accepts Shredder-FEN/X-FEN
    // rook-file letters. Mirrors app.py's _validate_fen_format exactly —
    // same accepted grammar, same rejected input — so a FEN the frontend
    // accepts is never one the backend then rejects, or vice versa.
    const _CASTLING_SYNTAX_STANDARD = /^K?Q?k?q?$/;
    const _CASTLING_SYNTAX_CHESS960 = /^[A-Ha-hKQkq]{1,4}$/;
    function _castlingSyntaxError(variant, field) {
        if (field === '-') return null;
        const pattern = variant === VARIANTS.CHESS960 ? _CASTLING_SYNTAX_CHESS960 : _CASTLING_SYNTAX_STANDARD;
        if (pattern.test(field)) return null;
        const expected = variant === VARIANTS.CHESS960
            ? "some combination of 'K', 'Q', 'k', 'q', rook-file letters 'a'-'h'/'A'-'H', or '-'"
            : "some combination of 'K', 'Q', 'k', 'q', or '-'";
        return `Invalid castling availability: '${field}' (expected ${expected}).`;
    }

    // Parses and fully validates a FEN into a chessops position under the
    // given variant (defaulting to the currently-active one), or returns a
    // user-facing reason it was rejected. Rejects a syntactically-valid
    // chessops parse that isn't actually a legal encoding for the
    // requested variant (see the two checks above and the module doc
    // comment) — the same FEN text can be accepted under one variant and
    // rejected under the other.
    function _buildPosition(fen, variant = _variant) {
        const fields = fen.split(' ');
        if (fields.length >= 3) {
            const syntaxError = _castlingSyntaxError(variant, fields[2]);
            if (syntaxError) return { ok: false, reason: syntaxError };
        }
        const parsed = parseFen(fen);
        if (parsed.isErr) return { ok: false, reason: _fenErrorMessage(parsed.error) };
        const setup = parsed.value;
        const built = Chess.fromSetup(setup);
        if (built.isErr) return { ok: false, reason: _positionErrorMessage(built.error) };
        const pos = built.value;
        const missing = _missingCastlingRights(setup, pos);
        if (missing.length) {
            return { ok: false, reason: `Invalid castling availability: no matching king and rook for ${missing.join(', ')}.` };
        }
        if (variant !== VARIANTS.CHESS960) {
            const nonOrthodox = _nonOrthodoxCastlingRights(pos);
            if (nonOrthodox.length) {
                return {
                    ok: false,
                    reason: `Invalid castling availability: Standard chess requires the king and rook on their home squares (${nonOrthodox.join(', ')} is not one).`,
                };
            }
        }
        return { ok: true, pos };
    }

    function _pieceCodeOf(piece) {
        if (!piece) return null;
        const letter = piece.role === 'knight' ? 'N' : piece.role[0].toUpperCase();
        return (piece.color === 'white' ? 'w' : 'b') + letter;
    }

    // Total legal move count, counting each underpromotion choice as a
    // separate move (matching the count a full legal-move generator would
    // report) rather than one destination square per promoting pawn move.
    // Includes Chess960 castling moves — they're just another destination
    // chessops's own move generation supplies (see chessgroundDests below).
    function _countLegalMoves(pos) {
        const ctx = pos.ctx();
        let count = 0;
        for (const [from, squares] of pos.allDests(ctx)) {
            const promotes = pos.board.pawn.has(from);
            for (const to of squares) {
                const isPromotion = promotes && (to < 8 || to >= 56);
                count += isPromotion ? 4 : 1;
            }
        }
        return count;
    }

    // Builds chessground's `movable.dests` shape from the active position,
    // using the variant-aware compatibility bridge. Standard mode exposes
    // orthodox king-destination castling only; Chess960 exposes the
    // king-to-rook destination.
    function _legalDestsMap() {
        if (!_position) return new Map();
        const dests = chessgroundDests(_position, { chess960: _variant === VARIANTS.CHESS960 });
        if (_variant === VARIANTS.CHESS960) return dests;

        const filtered = new Map();
        for (const [from, squares] of dests) {
            const fromSquare = parseSquare(from);
            const allowed = squares.filter(to => {
                const toSquare = parseSquare(to);
                const side = castlingSide(_position, { from: fromSquare, to: toSquare });
                if (!side) return true;
                return toSquare !== _position.castles.rook[_position.turn][side];
            });
            if (allowed.length) filtered.set(from, allowed);
        }
        return filtered;
    }

    // ── Chessground sync ──────────────────────────────────────────────────────
    // The single point where _position's state is pushed into chessground.
    // Called unconditionally after every position-changing action — even a
    // "legal move" one, since chessground's own baseMove() has no concept of
    // en passant, promotion, or Chess960 castling and can leave its internal
    // state briefly chess-wise-incorrect (e.g. not removing the captured
    // pawn on an en passant capture, leaving a pawn on the back rank instead
    // of the promoted piece, or leaving the rook wherever it was dragged
    // from instead of its final castled square) until this call corrects
    // it. Chessground's internal state is not authoritative;
    // this call always overwrites it from _position.
    function _syncChessground() {
        if (!cg || !_position) return;
        cg.set({
            fen:       currentFen(),
            turnColor: _position.turn,
            check:     _position.isCheck() ? _position.turn : false,
            lastMove:  _lastMoveKeys,
            // Locked: restrict dragging/click-move to the side to move's
            // legal destinations. Unlocked: free editing.
            movable: {
                free:  !_locked,
                color: _locked ? _position.turn : 'both',
                dests: _locked ? _legalDestsMap() : undefined,
            },
            // Off-board drop-to-delete is disabled while locked, same as the
            // spare trays below.
            draggable: { deleteOnDropOff: !_locked },
        });
    }

    // ── Promotion ─────────────────────────────────────────────────────────────
    // pieceCode is a two-letter code like 'wP' (colour + uppercase type),
    // matching the shape the rest of this file (and theme.js) already uses.
    function _isPromotionMove(target, pieceCode) {
        if (!pieceCode || pieceCode[1] !== 'P') return false;
        const color = pieceCode[0], rank = target[1];
        return (color === 'w' && rank === '8') || (color === 'b' && rank === '1');
    }
    // Maps the promotion dialog's single-letter piece codes to chessops's
    // full role names.
    const ROLE_OF = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

    function _showPromotionDialog(source, target, color) {
        _pendingPromotion = { source, target };
        const dialog = document.getElementById('promotion-dialog');
        ['q','r','b','n'].forEach(p => {
            const btn = dialog.querySelector(`.promotion-piece-btn[data-piece="${p}"]`);
            const img = btn && btn.querySelector('img');
            if (img) img.src = _pieceTheme(color + p.toUpperCase());
        });
        dialog.classList.add('is-visible');
        dialog.querySelector('.promotion-piece-btn')?.focus();
    }
    function _hidePromotionDialog() {
        document.getElementById('promotion-dialog').classList.remove('is-visible');
    }
    // Cancelling (Escape / backdrop click) needs to resync now, since
    // chessground has already visually relocated the pawn to the target
    // square by the time the dialog is showing (its own drag/drop already
    // moved the piece before this handler ever runs). This call reverts
    // that visual relocation by pushing _position's still-unchanged state
    // back into chessground.
    function _cancelPromotion() {
        _hidePromotionDialog();
        _pendingPromotion = null;
        _syncChessground();
    }
    function _onPromotionSelect(pieceLetter) {
        _hidePromotionDialog();
        if (!_pendingPromotion) return;
        const { source, target } = _pendingPromotion;
        _pendingPromotion = null;
        const move = { from: parseSquare(source), to: parseSquare(target), promotion: ROLE_OF[pieceLetter.toUpperCase()] };
        if (!_position.isLegal(move)) { _syncChessground(); return; }   // revert the visual pawn-on-back-rank relocation
        const san = makeSan(_position, move);
        _position.play(move);
        _lastMoveKeys = [source, target];
        _addMove(san, currentFen(), source, target);
        _emitHistory();
        _syncChessground();
        // immediate=true: a completed promotion is a single, definite move
        // (see playMove()'s own comment on this parameter), not part of a
        // rapid-fire stream of changes the debounce below it is meant to
        // guard against.
        if (_onPositionChange) _onPositionChange(currentFen(), true, true);
    }

    // ── Core sync algorithm ──────────────────────────────────────────────────
    // Chessground fires multiple, differently-scoped callbacks for what a
    // user experiences as a single action (events.move, events.change,
    // movable.events.after, events.dropNewPiece), so rather than track
    // which-callback-handled-what with suppression flags, this handler is
    // idempotent: it compares chessground's current placement against
    // _position's, and no-ops if they already match.
    //
    // events.move is wired as the informative hook (the one that passes
    // origHint/destHint below) rather than movable.events.after, based on
    // chessground's actual event-firing order for an ordinary relocation:
    // events.move fires first (scheduled from within board.ts's baseMove()),
    // then events.change (also scheduled by baseMove(), immediately after),
    // then movable.events.after (scheduled later by userMove()) — all via
    // setTimeout(fn,1), so same-delay-timer FIFO ordering makes this
    // deterministic, not a race (confirmed directly from chessground's
    // source). events.change carries no orig/dest, so if it were the
    // informative hook it would always take the generic "board edit" branch
    // below first, leaving movable.events.after's real orig/dest with
    // nothing left to act on once it fires — the idempotency guard would
    // already see the position as synced. events.move avoids that: it
    // fires before events.change and, unlike movable.events.after, carries
    // orig/dest (plus capture info), so it reliably wins the idempotency
    // race with enough information to classify the move correctly.
    // events.change and movable.events.after stay wired below as idempotent
    // fallbacks/no-ops for a relocation; events.change remains load-bearing
    // for the one case with no orig/dest-carrying hook at all — an
    // off-board deletion (drag.ts's deleteOnDropOff branch).
    //
    // Standard mode accepts only the orthodox king-destination castle;
    // Chess960 accepts the king-to-rook representation.
    function _handleBoardMutation(origHint, destHint) {
        if (!cg || !_position) return;
        const cgPlacement  = cg.getFen();                 // chessground's own current placement-only FEN
        const ourPlacement = currentFen().split(' ')[0];
        if (cgPlacement === ourPlacement) return;          // already synced by another callback this tick

        if (origHint && destHint) {
            // _position hasn't moved yet at this point — only chessground
            // has — so the piece that was at origHint is still readable
            // from _position.
            const pieceCode = _pieceCodeOf(_position.board.get(parseSquare(origHint)));
            if (pieceCode && _isPromotionMove(destHint, pieceCode)) {
                _showPromotionDialog(origHint, destHint, pieceCode[0]);
                return;   // resolved later by _onPromotionSelect()/_cancelPromotion()
            }
            const move = { from: parseSquare(origHint), to: parseSquare(destHint) };
            if (_variant === VARIANTS.STANDARD) {
                const side = castlingSide(_position, move);
                if (side && move.to === _position.castles.rook[_position.turn][side]) {
                    _syncChessground();
                    return;
                }
            }
            if (_position.isLegal(move)) {
                const san = makeSan(_position, move);
                _position.play(move);
                _lastMoveKeys = [origHint, destHint];
                _addMove(san, currentFen(), origHint, destHint);
                _emitHistory();
                _syncChessground();
                // immediate=true: see the comment on the equivalent call in
                // _onPromotionSelect() above — a completed drag-and-drop
                // move is a single, definite move too.
                if (_onPositionChange) _onPositionChange(currentFen(), true, true);
                return;
            }
            // Not legal — fall through to the generic edit path below, which
            // reads the placement chessground already committed rather than
            // origHint/destHint.
        }

        // Board-edit path: spare-piece drop, off-board delete, or an
        // illegal relocation. Castling rights and the en passant square are
        // always dropped here because an edited placement's rights can no
        // longer be assumed valid.
        const prevFen = currentFen();
        const nextFen = `${cgPlacement} ${_turnChar(_position)} - - 0 1`;
        const built = _buildPosition(nextFen);
        if (!built.ok) { _syncChessground(); return; }   // invalid resulting position — snap back
        _position = built.pos;
        _pushHistory(prevFen);
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        if (_onPositionChange) _onPositionChange(currentFen(), false);
    }

    function _onCgSelect(key) {
        if (!_clickPlacePiece) return;         // not in placement mode — let chessground handle the click normally
        cg.selectSquare(null);                  // clear any selection chessground itself may have started,
                                                 // so a piece "armed" for placement never gets relocated
                                                 // by chessground's own click-to-move instead
        const role  = ROLE_OF[_clickPlacePiece[1]];
        const color = _clickPlacePiece[0] === 'w' ? 'white' : 'black';
        const square = parseSquare(key);
        if (role === 'king') {
            const existing = _position.board.kingOf(color);
            if (existing !== undefined && existing !== square) return;   // rejected — a king of this colour already exists elsewhere
        }
        const prevFen = currentFen();
        _position.board.set(square, { role, color, promoted: false });
        // Re-derive castling rights from the edited board rather than
        // leaving stale rook/king square references behind (e.g. a right
        // pointing at a square this edit just overwrote).
        _position.castles = Castles.fromSetup({ board: _position.board, castlingRights: _position.castles.castlingRights });
        _pushHistory(prevFen);
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        if (_onPositionChange) _onPositionChange(currentFen(), false);
    }

    // ── Best-move arrows (DTZ / DTC / DTM / DTM50) ────────────────────────────
    // Native chessground feature (drawable.autoShapes) — square keys, not
    // pixel coordinates, so chessground handles orientation/resizing itself.
    // bestMoves: { dtz: entry|null, dtc: entry|null, dtm: entry|null,
    // dtm50: entry|null } — the top-ranked move for each metric (any of
    // which may be missing, e.g. for a terminal or not-yet-probed position).
    function drawArrows(bestMoves) {
        if (!cg) return;
        if (!bestMoves) { cg.setAutoShapes([]); return; }
        const shapes = [];
        ['dtz', 'dtc', 'dtm', 'dtm50'].forEach(metric => {
            const entry = bestMoves[metric];
            if (!entry) return;
            const move = parseSan(_position, entry.san);
            if (!move) return;
            const side = _variant === VARIANTS.STANDARD ? castlingSide(_position, move) : undefined;
            const dest = side
                ? `${side === 'a' ? 'c' : 'g'}${_position.turn === 'white' ? '1' : '8'}`
                : makeSquare(move.to);
            shapes.push({ orig: makeSquare(move.from), dest, brush: metric });
        });
        cg.setAutoShapes(shapes);
    }
    function clearArrows() {
        if (!cg) return;
        cg.setAutoShapes([]);
    }

    // ── Click-to-place + spare-piece trays ───────────────────────────────────
    let _clickPlacePiece = null;   // e.g. 'wQ', 'bK', or null

    function _toCgPiece(code /* e.g. 'wQ' */) {
        return { color: code[0] === 'w' ? 'white' : 'black', role: ROLE_OF[code[1]] };
    }

    function _populateTrayImages() {
        document.querySelectorAll('.spare-piece').forEach(btn => {
            const code = btn.dataset.piece;
            const img  = btn.querySelector('img');
            if (img && code) img.src = _pieceTheme(code);
        });
    }

    // Two interaction paths, both needed: click-to-place (click a tray
    // piece, then click a destination square) and drag-from-tray (native
    // HTML5 drag onto the board, handled via chessground's dragNewPiece()).
    // The spare-piece trays are expected to support both at once, so
    // neither wiring below can assume the other is absent.
    function _initSpareTrays() {
        document.querySelectorAll('.spare-piece').forEach(btn => {
            const code = btn.dataset.piece;

            // Path 1: click tray piece, then click a square — handled by
            // this click listener (arms _clickPlacePiece) plus _onCgSelect()
            // (does the actual placement), wired in init()'s Config.events.select.
            // Disabled while locked (tray is also dimmed — see setLocked()).
            btn.addEventListener('click', () => {
                if (_locked) return;
                setClickPlacePiece(_clickPlacePiece === code ? null : code);
            });

            // Path 2: drag a tray piece directly onto the board. `force:
            // true` is required — cg.dragNewPiece() without it refuses to
            // overwrite an occupied square, and dropping a spare piece onto
            // an occupied square is expected to replace it. Disabled while locked.
            btn.addEventListener('pointerdown', e => {
                if (_locked) return;
                if (e.button !== undefined && e.button !== 0) return;   // primary pointer only
                cg.dragNewPiece(_toCgPiece(code), e, /* force */ true);
            });
        });

        // Escape clears click-to-place selection
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && _clickPlacePiece) setClickPlacePiece(null);
        });
    }

    function setClickPlacePiece(piece) {
        _clickPlacePiece = piece;
        // Visual feedback
        document.querySelectorAll('.spare-piece.cp-selected').forEach(el => el.classList.remove('cp-selected'));
        if (piece) {
            document.querySelectorAll(`.spare-piece[data-piece="${piece}"]`).forEach(el => el.classList.add('cp-selected'));
        }
        // Update cursor on board
        const boardEl = document.getElementById('board');
        if (boardEl) {
            boardEl.classList.toggle('cp-active', !!piece);
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function _restoredOrientation() {
        try { return localStorage.getItem('chesstb_orientation') === 'black' ? 'black' : 'white'; }
        catch (_) { return 'white'; }
    }

    function _restoredLocked() {
        try { return localStorage.getItem('chesstb_locked') === 'true'; }
        catch (_) { return false; }
    }

    // variant, if given, must be VARIANTS.STANDARD or VARIANTS.CHESS960 and
    // takes precedence over any caller-independent default — callers that
    // already know the intended variant (a URL share-link, a restored saved
    // game) pass it explicitly so the position below is constructed under
    // the correct ruleset context from the very first render, per this
    // file's variant-before-position invariant. Omitted or invalid values
    // fall back to Standard.
    function init(onPositionChange, initialFen, variant) {
        _onPositionChange = onPositionChange;
        _variant = (variant === VARIANTS.CHESS960) ? VARIANTS.CHESS960 : VARIANTS.STANDARD;

        // Same validation setPosition() applies to every later position
        // change — an invalid initialFen (bad king count, unusable castling
        // rights, or anything else chessops rejects) falls back to the
        // default reset position, and the reason is returned below so the
        // caller can tell the user, instead of silently substituting a
        // different position with no feedback.
        const built = _buildPosition(initialFen);
        let loadError = null;
        if (built.ok) {
            _position = built.pos;
        } else {
            loadError = built.reason;
            _position = Chess.default();
        }
        _startFen = currentFen();

        // Built from _startFen (the validated/fallback position), not the
        // raw initialFen — otherwise an invalid initialFen leaves the
        // visible board showing the rejected placement while _position
        // already holds the fallback, a desync baked in right at startup.
        cg = Chessground(document.getElementById('board'), {
            fen:                  _startFen,
            orientation:          _restoredOrientation(),
            turnColor:            _position.turn,
            check:                _position.isCheck() ? _position.turn : false,
            lastMove:             undefined,
            coordinates:          true,
            // coordinatesOnSquares stays false: that mode prints a combined
            // "a8"-style label on all 64 squares, whereas this app wants the
            // classic look — a rank number down the left column and a file
            // letter along the bottom row only, both sitting inset at the
            // board's edges. Chessground's native coords.ranks/coords.files
            // strips (one rank-only label per row, one file-only label per
            // column) already produce that layout once repositioned via CSS
            // (see main.css) to sit inside the board edge instead of outside
            // it, so the combined per-square mode isn't needed here.
            coordinatesOnSquares: false,
            // Castling is driven by the chessops position (_position), not
            // chessground's own king-two-squares heuristic, so chessground
            // should never second-guess or auto-correct a king move into a
            // castle itself — this also holds for Chess960's king-to-rook
            // representation, which chessground has no native concept of.
            autoCastle:           false,
            viewOnly:             false,
            disableContextMenu:   true,
            highlight:            { lastMove: true, check: true },
            animation:            { enabled: true, duration: 200 },
            movable: {
                // Any drag is provisionally accepted here and classified
                // afterward by _handleBoardMutation, rather than gating
                // drags up front with a separate edit-mode toggle.
                free:  true,
                color: 'both',
                showDests: true,
                events: { after: (orig, dest) => _handleBoardMutation(orig, dest) },
            },
            premovable:  { enabled: false },
            draggable: {
                enabled:         true,
                showGhost:       true,
                deleteOnDropOff: true,
            },
            selectable: { enabled: true },
            events: {
                move:         (orig, dest) => _handleBoardMutation(orig, dest),
                change:       () => _handleBoardMutation(),
                dropNewPiece: () => _handleBoardMutation(),
                select:       (key) => _onCgSelect(key),
            },
            drawable: {
                enabled: true,
                visible: true,
                brushes: {
                    dtz:   { key: 'dtz',   color: '#2451c4', opacity: 0.80, lineWidth: 10 },
                    dtc:   { key: 'dtc',   color: '#d113c6', opacity: 0.80, lineWidth: 10 },
                    dtm:   { key: 'dtm',   color: '#8b93a1', opacity: 0.80, lineWidth: 10 },
                    dtm50: { key: 'dtm50', color: '#e1453a', opacity: 0.80, lineWidth: 10 },
                },
            },
        });

        const dialog = document.getElementById('promotion-dialog');
        dialog.querySelectorAll('.promotion-piece-btn').forEach(btn => {
            btn.addEventListener('click', () => _onPromotionSelect(btn.dataset.piece));
        });
        dialog.addEventListener('click', e => {
            if (e.target === dialog) _cancelPromotion();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && dialog.classList.contains('is-visible')) _cancelPromotion();
        });

        _populateTrayImages();
        _initSpareTrays();
        _syncTrayOrientation();

        // Restored the same way orientation is above — persist:false since
        // this is a stored preference being applied on load, not a new one
        // being set, so it's not written straight back to the same key.
        setLocked(_restoredLocked(), false);

        return loadError ? { ok: false, reason: loadError } : { ok: true };
    }

    /**
     * Set the piece-set CSS <link> and populate the spare-tray and
     * promotion-dialog images. Registered with theme.js via
     * Theme.init(reconstruct) and invoked once at bootstrap, after theme.js
     * injects the board's theme <style> tag.
     *
     * This never touches the Chessground instance itself — piece images are
     * plain CSS (`.cg-wrap piece.<role>.<color>`), not baked into a
     * constructor closure.
     */
    function reconstruct(pieceThemeFn) {
        if (!cg || !_position) return;
        const link = document.getElementById('chesstb-piece-css');
        if (link) link.href = `/static/css/pieces-${Theme.currentPieceSet()}.css`;
        _populateTrayImages();
    }

    function setPosition(fen) {
        const prevFen = _position ? currentFen() : null;
        // Re-submitting the FEN already on the board (e.g. pressing Enter in
        // the FEN box without editing it) is a no-op — skip the undo-stack
        // push and tree reset so the current move line survives it.
        if (fen === prevFen) return { ok: true };
        const built = _buildPosition(fen);
        if (!built.ok) return { ok: false, reason: built.reason };
        _position = built.pos;
        _pushHistory(prevFen);
        _hidePromotionDialog();
        _pendingPromotion = null;
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        // Invoke the position-change callback here, the same way
        // playMove()/goBack()/goForward()/goToNode() already do, instead of
        // leaving every caller to remember to call it (and to probe the
        // tablebase) manually. See clear() below for the same behaviour.
        const nextFen = currentFen();
        if (_onPositionChange) _onPositionChange(nextFen, false);
        return { ok: true };
    }

    // Sets a new FEN and variant together in a single step — for a caller
    // that is replacing the position anyway (a shared URL, PGN import,
    // restoreTree()'s fallback path), so there is no "current position"
    // to preserve or validate against the new variant; the new FEN is
    // validated directly against the new variant instead (see
    // _buildPosition). Use setVariant() instead when the FEN is meant to
    // stay exactly as it is and only its interpretation should change
    // (e.g. the settings-panel toggle).
    function setPositionAndVariant(fen, variant) {
        const next = (variant === VARIANTS.CHESS960) ? VARIANTS.CHESS960 : VARIANTS.STANDARD;
        const prevFen = _position ? currentFen() : null;
        if (fen === prevFen && next === _variant) return { ok: true };   // true no-op
        const built = _buildPosition(fen, next);
        if (!built.ok) return { ok: false, reason: built.reason };
        _variant = next;
        _position = built.pos;
        if (prevFen !== null) _pushHistory(prevFen);
        _hidePromotionDialog();
        _pendingPromotion = null;
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        if (_onPositionChange) _onPositionChange(currentFen(), false);
        return { ok: true };
    }

    function clear() {
        const prevFen  = currentFen();
        const resetFen = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
        const built = _buildPosition(resetFen);
        if (!built.ok) { _syncChessground(); return resetFen; }   // unreachable — resetFen is always valid
        _pushHistory(prevFen);
        _position = built.pos;
        _hidePromotionDialog();
        _pendingPromotion = null;
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        // See setPosition() above.
        if (_onPositionChange) _onPositionChange(resetFen, false);
        return resetFen;
    }

    // Mirrors chessground's own orientation as a class on #board-wrap-inner;
    // main.css uses it to flip flex-direction so the spare-piece trays swap
    // sides visually without moving them in the DOM.
    function _syncTrayOrientation() {
        const wrapEl = document.getElementById('board-wrap-inner');
        if (wrapEl) wrapEl.classList.toggle('orientation-black', cg.state.orientation === 'black');
    }

    function flip() {
        cg.toggleOrientation();
        _syncTrayOrientation();
        try { localStorage.setItem('chesstb_orientation', cg.state.orientation); } catch (_) {}
        clearArrows();   // arrows are orientation-dependent; caller (ui.js) redraws right after flip
    }

    // ── Lock mode (public) ───────────────────────────────────────────────────
    // Toggles legal-moves-only board interaction. Persisted to localStorage
    // the same way orientation is (see flip()) when persist defaults to
    // true; callers applying an already-known value (init() restoring on
    // load, or ui.js's auto-play engaging/releasing Lock) pass persist:false.
    function setLocked(locked, persist = true) {
        _locked = !!locked;
        if (_locked) setClickPlacePiece(null);   // drop any armed spare piece
        document.querySelectorAll('.spare-tray').forEach(el => {
            el.classList.toggle('is-locked', _locked);
            if (_locked) el.setAttribute('title', 'Board is locked');
            else el.removeAttribute('title');
        });
        if (persist) {
            try { localStorage.setItem('chesstb_locked', String(_locked)); } catch (_) {}
        }
        _syncChessground();
    }
    function isLocked() { return _locked; }

    // ── Variant (public) ─────────────────────────────────────────────────────
    // Persistence and toggle-panel wiring live in ui.js (Chess960 Mode is a
    // Settings-panel item, alongside Autoplay Delay and Show Root Row — see
    // ui.js's _initSettings) — this module only holds the current value and
    // reacts to it changing.
    function setVariant(variant) {
        const next = (variant === VARIANTS.CHESS960) ? VARIANTS.CHESS960 : VARIANTS.STANDARD;
        if (next === _variant) return { ok: true };
        // This reinterprets the CURRENT position under a different
        // variant — the FEN itself is not changing (see
        // setPositionAndVariant() above for the "also loading a new
        // position" case) — so unlike every other _buildPosition() call in
        // this file, failure here must not fall back to a default
        // position or otherwise change what's on the board: the position
        // simply isn't representable under the requested variant's
        // castling rules (e.g. Chess960-only castling rights present, or
        // Chess960 castling rights on non-home squares — see
        // _nonOrthodoxCastlingRights), and the switch is refused outright,
        // leaving variant and position exactly as they were.
        if (_position) {
            const trial = _buildPosition(currentFen(), next);
            if (!trial.ok) {
                const modeName = next === VARIANTS.CHESS960 ? 'Chess960' : 'Standard';
                return { ok: false, reason: `Can't switch to ${modeName} mode: ${trial.reason}` };
            }
        }
        _variant = next;
        // The move tree belongs to the active variant; changing variants
        // starts a fresh tree from the current position.
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        // Position change with no actual FEN change — still routed through
        // onPositionChange so callers re-probe under the new variant and
        // (via onPositionChange's own guard) auto-play is stopped rather
        // than left running against a variant it started under.
        if (_onPositionChange) _onPositionChange(currentFen(), false);
        return { ok: true };
    }
    function getVariant()  { return _variant; }
    function isChess960()  { return _variant === VARIANTS.CHESS960; }

    // Legal move count for the current position, counting each
    // underpromotion choice separately (see _countLegalMoves above) and
    // including Chess960 castling. Used by ui.js instead of constructing a
    // temporary rules-engine object of its own.
    function legalMoveCount() { return _position ? _countLegalMoves(_position) : 0; }

    // Result token for an arbitrary FEN, independent of the live board
    // state — used by ui.js's PGN-result detection. Returns '*' (unknown/
    // in progress) for a FEN that fails to parse, exactly like the
    // current chessops position directly, without an intermediate engine.
    function outcomeFromFen(fen) {
        const built = _buildPosition(fen);
        if (!built.ok) return '*';
        const pos = built.pos;
        if (pos.isCheckmate()) return pos.turn === 'white' ? '0-1' : '1-0';
        if (pos.isStalemate() || pos.isInsufficientMaterial()) return '1/2-1/2';
        return '*';
    }

    function playMove(san) {
        if (!_position) return false;
        const move = parseSan(_position, san);
        if (!move) return false;
        const fromKey = makeSquare(move.from), toKey = makeSquare(move.to);
        const playedSan = makeSan(_position, move);
        _position.play(move);

        _lastMoveKeys = [fromKey, toKey];

        // Track in the move tree (branches instead of overwriting if the
        // user had navigated back before playing this move).
        _addMove(playedSan, currentFen(), fromKey, toKey);
        _emitHistory();
        _syncChessground();

        // immediate=true: this is a single, definite move (played by
        // auto-play or by clicking a move in the ranked-moves table, the
        // two callers of playMove() — see ui.js), not a rapid-fire stream
        // of changes the 300ms debounce is meant to guard against. Without
        // this, onPositionChange()'s `immediate` parameter is left
        // undefined and every played move's probe sits behind the 300ms
        // debounce for no reason — most visible as a flat ~300ms of extra
        // latency between auto-play moves even with Autoplay Delay set to
        // 0s, on top of (and indistinguishable from) actual probe latency.
        if (_onPositionChange) _onPositionChange(currentFen(), true, true);
        return true;
    }

    // Back/Forward walk the move tree directly (parent / activeChild) so
    // stepping through a line that includes variations works the same as
    // stepping through the main line. The plain _history/_future FEN stack
    // is only consulted once navigation reaches the tree's root (id ROOT)
    // and goes further back than the tree itself — i.e. undoing past
    // whatever move/edit started the current tree (see _resetMoveLine).
    function goBack() {
        if (_currentId !== ROOT) {
            const parentId = _nodes[_currentId].parentId;
            const fen = parentId === ROOT ? _startFen : _nodes[parentId].fen;
            const built = _buildPosition(fen);
            if (!built.ok) { _syncChessground(); return false; }
            _position = built.pos;
            _lastMoveKeys = parentId === ROOT ? undefined : [_nodes[parentId].from, _nodes[parentId].to];
            _currentId = parentId;
        } else {
            if (_history.length === 0) return false;
            const prevFen = _history.pop();
            _future.push(currentFen());
            const built = _buildPosition(prevFen);
            if (!built.ok) {
                _future.pop();
                _syncChessground();
                return false;
            }
            _position = built.pos;
            // The plain _history/_future stack holds FENs only, with no
            // accompanying from/to squares (unlike tree nodes), so there's
            // nothing to highlight as the last move here.
            _lastMoveKeys = undefined;
            // The loaded position does not match the tree's _startFen, so
            // the tree is reset. _resetMoveLine() also clears _future, so the
            // stack is saved and restored around the reset.
            const _pendingFuture = _future.slice();
            _resetMoveLine();
            _future = _pendingFuture;
        }
        _hidePromotionDialog();
        _pendingPromotion = null;
        _syncChessground();
        _emitHistory();
        if (_onPositionChange) _onPositionChange(currentFen(), false);
        return true;
    }

    function goForward() {
        const activeChildId = _activeChildOf(_currentId);
        if (activeChildId !== null && activeChildId !== undefined) {
            const node = _nodes[activeChildId];
            const built = _buildPosition(node.fen);
            if (!built.ok) { _syncChessground(); return false; }
            _position = built.pos;
            _lastMoveKeys = [node.from, node.to];
            _currentId = activeChildId;
        } else if (_currentId === ROOT && _future.length > 0) {
            const nextFen = _future.pop();
            const built = _buildPosition(nextFen);
            if (!built.ok) {
                _future.push(nextFen);
                _syncChessground();
                return false;
            }
            _history.push(currentFen());
            _position = built.pos;
            _lastMoveKeys = undefined;
            // Mirrors the goBack() fallback above: the position just loaded
            // isn't described by the current (already-reset) tree either, so
            // restart the tree here too and preserve any remaining redo
            // entries across the reset.
            const _pendingFuture = _future.slice();
            _resetMoveLine();
            _future = _pendingFuture;
        } else {
            return false;
        }
        _hidePromotionDialog();
        _pendingPromotion = null;
        _syncChessground();
        _emitHistory();
        if (_onPositionChange) _onPositionChange(currentFen(), false);
        return true;
    }

    // goToNode() jumps to an arbitrary node in the *current* move tree (used
    // by the PGN panel — including variation moves, not just the main line).
    // Unlike setPosition(), this never calls _resetMoveLine(). targetId ===
    // ROOT (-1) means "start of the tree" (the position before any move was
    // played). Clicking any node marks it — and every ancestor on the path
    // to it — as its parent's activeChild, so Forward continues along
    // whichever branch was just brought into view.
    function goToNode(targetId) {
        if (targetId !== ROOT && !_nodes[targetId]) return false;
        if (targetId === _currentId) return true;

        const fen = targetId === ROOT ? _startFen : _nodes[targetId].fen;
        const built = _buildPosition(fen);
        if (!built.ok) return false;
        _position = built.pos;

        const chain = [];
        let walk = targetId;
        while (walk !== ROOT) { chain.unshift(walk); walk = _nodes[walk].parentId; }
        let parent = ROOT;
        chain.forEach(id => { _setActiveChild(parent, id); parent = id; });
        _currentId = targetId;
        _lastMoveKeys = targetId === ROOT ? undefined : [_nodes[targetId].from, _nodes[targetId].to];

        _hidePromotionDialog();
        _pendingPromotion = null;
        _syncChessground();
        _emitHistory();
        if (_onPositionChange) _onPositionChange(currentFen(), false);
        return true;
    }

    // restoreTree() rehydrates a full move tree (start position + every
    // node + current node) from persisted state in a single board update,
    // without replaying each move or triggering individual probes.
    // The active variant must already be established (via init()'s variant
    // argument) before this is called — this function only restores
    // position/tree data, never variant.
    function restoreTree(startFen, nodes, rootChildren, rootActiveChild, currentId) {
        if (!_position || !startFen) return false;
        const safeNodes        = Array.isArray(nodes) ? nodes : [];
        const safeRootChildren = Array.isArray(rootChildren) ? rootChildren : [];
        const safeCurrentId    = (currentId === ROOT || (typeof currentId === 'number' && safeNodes[currentId]))
            ? currentId : ROOT;

        const loadFen = safeCurrentId === ROOT ? startFen : safeNodes[safeCurrentId].fen;
        const built = _buildPosition(loadFen);
        if (!built.ok) {
            // Saved state doesn't parse (e.g. corrupted storage) — fall back
            // to just the start position with an empty tree.
            const fallback = _buildPosition(startFen);
            _position = fallback.ok ? fallback.pos : Chess.default();
            _startFen         = currentFen();
            _nodes            = [];
            _rootChildren     = [];
            _rootActiveChild  = null;
            _currentId        = ROOT;
            _history          = [];
            _future           = [];
            _lastMoveKeys     = undefined;
            if (cg) {
                _hidePromotionDialog();
                _syncChessground();
            }
            _emitHistory();
            return false;
        }
        _position = built.pos;

        _startFen        = startFen;
        _nodes            = safeNodes;
        _rootChildren     = safeRootChildren;
        _rootActiveChild  = (typeof rootActiveChild === 'number') ? rootActiveChild : null;
        _currentId        = safeCurrentId;
        _history          = [];
        _future           = [];
        _lastMoveKeys     = (safeCurrentId === ROOT || !safeNodes[safeCurrentId])
            ? undefined
            : [safeNodes[safeCurrentId].from, safeNodes[safeCurrentId].to];

        _hidePromotionDialog();
        _pendingPromotion = null;
        if (cg) _syncChessground();
        _emitHistory();
        return true;
    }

    function canGoBack()    { return _currentId !== ROOT || _history.length > 0; }
    function canGoForward() {
        const activeChildId = _activeChildOf(_currentId);
        return (activeChildId !== null && activeChildId !== undefined) || (_currentId === ROOT && _future.length > 0);
    }

    function getMoveHistory() {
        return { nodes: _nodes, rootChildren: _rootChildren, rootActiveChild: _rootActiveChild, currentId: _currentId };
    }
    function getStartFen() { return _startFen; }       // PGN formatting
    function setOnMoveHistoryChange(fn) {
        _onMoveHistoryChange = fn;
    }

    return {
        init, reconstruct, setPosition, setPositionAndVariant, clear, flip, currentFen,
        playMove, goBack, goForward, goToNode, restoreTree, canGoBack, canGoForward,
        getMoveHistory, getStartFen, setOnMoveHistoryChange,
        drawArrows, clearArrows,
        setLocked, isLocked,
        setVariant, getVariant, isChess960, legalMoveCount, outcomeFromFen,
    };

})();

export { Board, VARIANTS };
