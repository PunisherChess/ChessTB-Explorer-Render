/**
 * pgnFormat.js: PGN export text and PGN import parsing
 *
 * Walks the move tree with the same helpers (tree.js) as the move-list
 * panel so the two can't disagree about where a variation forks.
 */

import { Board } from './board.js';
import { VARIANTS, ROOT_ID } from './constants.js';
import { childrenOf, collectMainPath } from './tree.js';
import { Chess } from '../vendor/chessops/chess.js';
import { parseFen, makeFen } from '../vendor/chessops/fen.js';
import { parsePgnStrict, PgnError } from '../vendor/chessops/pgn.js';
import { parseSan, makeSan } from '../vendor/chessops/san.js';
import { makeSquare } from '../vendor/chessops/util.js';

// Derives {turn, fullmove} from a FEN's 2nd/6th fields, for numbering a
// move line that doesn't start from a fresh game.
export function parseFenMeta(fen) {
    const parts = String(fen || '').trim().split(/\s+/);
    const turn     = parts[1] === 'b' ? 'b' : 'w';
    const fullmove = parseInt(parts[5], 10);
    return { turn, fullmove: Number.isFinite(fullmove) && fullmove > 0 ? fullmove : 1 };
}

// Same recursive shape as the move-list panel's own rendering - builds PGN
// movetext tokens (including variations, in "(...)" notation) instead of
// DOM/JSX nodes.
function buildMoveTokens(nodes, rootChildren, nodeIds, parentId, whiteToMove, moveNum, skipFirstFork) {
    const tokens = [];
    nodeIds.forEach((id, i) => {
        const node = nodes[id];
        if (whiteToMove) {
            tokens.push(`${moveNum}.`, node.san);
        } else if (i === 0) {
            tokens.push(`${moveNum}...`, node.san);
        } else {
            tokens.push(node.san);
        }
        if (!(i === 0 && skipFirstFork)) {
            const parentForThis = i === 0 ? parentId : nodeIds[i - 1];
            const kids = childrenOf(nodes, rootChildren, parentForThis);
            for (let v = 1; v < kids.length; v++) {
                const varPath = collectMainPath(nodes, kids[v]);
                const varTokens = buildMoveTokens(nodes, rootChildren, varPath, parentForThis, whiteToMove, moveNum, true);
                tokens.push(`(${varTokens.join(' ')})`);
            }
        }
        if (!whiteToMove) moveNum++;
        whiteToMove = !whiteToMove;
    });
    return tokens;
}

// Builds a PGN export: the standard tag-roster header block (plus
// FEN/SetUp, since the explorer's starting position is rarely the default
// array) followed by movetext ending in a result token.
export function buildPgnText() {
    const { nodes, rootChildren } = Board.getMoveHistory();
    if (!rootChildren || rootChildren.length === 0) return '';

    const startFen = Board.getStartFen();
    const mainPath = collectMainPath(nodes, rootChildren[0]);
    const finalFen = nodes[mainPath[mainPath.length - 1]].fen;
    const result   = Board.outcomeFromFen(finalFen);

    const today   = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${today.getFullYear()}.${pad(today.getMonth() + 1)}.${pad(today.getDate())}`;

    const headers = [
        ['Event',  'ChessTB Explorer'],
        ['Site',   '?'],
        ['Date',   dateStr],
        ['Round',  '?'],
        ['White',  '?'],
        ['Black',  '?'],
        ['Result', result],
    ];
    if (Board.isChess960()) headers.push(['Variant', 'Chess960']);
    headers.push(['FEN', startFen], ['SetUp', '1']);
    const headerBlock = headers.map(([k, v]) => `[${k} "${v}"]`).join('\n');

    const { turn, fullmove } = parseFenMeta(startFen);
    const tokens = buildMoveTokens(nodes, rootChildren, mainPath, ROOT_ID, turn === 'w', fullmove, false);
    tokens.push(result);

    return `${headerBlock}\n\n${tokens.join(' ')}`;
}

// Case-insensitive PGN tag lookup - chessops preserves whatever case the
// source PGN used.
function pgnHeaderValue(headers, name) {
    const wanted = name.toLowerCase();
    for (const key of headers.keys()) {
        if (key.toLowerCase() === wanted) return headers.get(key);
    }
    return null;
}

// chessops's own PGN Variant parsing maps every Chess960-like name to the
// same generic rules Standard uses, so Chess960 identity is read from the
// raw header text instead.
function isChess960VariantHeader(value) {
    return /chess\s*960|fischer\s*random/i.test(value || '');
}

// Parses and validates the entire game tree, including variations, into
// Board's move-history format and the variant declared by its Variant header.
// Returns { ok: false, error } on any rejection.
export function parsePgn(text) {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: '' };

    let games = [];
    try {
        games = parsePgnStrict(trimmed);
    } catch (error) {
        const msg = (error instanceof PgnError && error.message === 'ERR_PGN_MULTIPLE_GAMES')
            ? 'PGN contains multiple games. Paste one game at a time.'
            : 'Could not parse PGN. Check the format and try again.';
        return { ok: false, error: msg };
    }
    const game = games[0];
    const moves = game ? [...game.moves.mainline()] : [];
    if (!game || (game.headers.size === 0 && moves.length === 0)) {
        return { ok: false, error: 'Could not parse PGN. Check the format and try again.' };
    }

    const variant = isChess960VariantHeader(pgnHeaderValue(game.headers, 'Variant'))
        ? VARIANTS.CHESS960 : VARIANTS.STANDARD;

    const fenHeader = pgnHeaderValue(game.headers, 'FEN');
    if (variant === VARIANTS.CHESS960 && !fenHeader) {
        return { ok: false, error: 'Chess960 PGN requires a FEN starting position.' };
    }
    let pos = null;
    if (fenHeader) {
        const parsed = parseFen(fenHeader);
        const built  = parsed.isErr ? null : Chess.fromSetup(parsed.value);
        pos = (built && !built.isErr) ? built.value : null;
        if (!pos) return { ok: false, error: 'Invalid FEN starting position in PGN.' };
    }
    if (!pos) pos = Chess.default();
    const startFen = makeFen(pos.toSetup());

    const tree = { startFen, nodes: [], rootChildren: [], rootActiveChild: null, currentId: ROOT_ID };
    const pending = [{ source: game.moves, parentId: ROOT_ID, pos }];
    // An explicit stack handles long lines without recursion limits.
    while (pending.length) {
        const frame = pending.pop();
        const next = [];
        for (const child of frame.source.children) {
            const childPos = frame.pos.clone();
            const move = parseSan(childPos, child.data.san);
            if (!move) return { ok: false, error: `Invalid move in PGN: ${child.data.san}` };
            const san = makeSan(childPos, move);
            childPos.play(move);
            const id = tree.nodes.length;
            tree.nodes.push({
                id, san, fen: makeFen(childPos.toSetup()),
                from: makeSquare(move.from), to: makeSquare(move.to),
                parentId: frame.parentId, children: [], activeChild: null,
            });
            if (frame.parentId === ROOT_ID) {
                tree.rootChildren.push(id);
                if (tree.rootActiveChild === null) tree.rootActiveChild = id;
            } else {
                const parent = tree.nodes[frame.parentId];
                parent.children.push(id);
                if (parent.activeChild === null) parent.activeChild = id;
            }
            next.push({ source: child, parentId: id, pos: childPos });
        }
        // The main continuation is visited first, in source branch order.
        pending.push(...next.reverse());
    }
    return { ok: true, tree, variant };
}
