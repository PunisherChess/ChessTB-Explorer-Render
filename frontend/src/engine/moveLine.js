/**
 * moveLine.js: move-tree → render items
 *
 * Walks the branching move tree the same way the PGN exporter does (see
 * tree.js's childrenOf/collectMainPath) and produces a flat list of
 * render items for the move-list panel: 'row' items for the main line's
 * Rank/White/Black grid, and 'fork' items grouping the alternatives to a
 * main-line move. Each 'variation' item of a fork carries enough to expand
 * into its own paragraph without re-walking the tree.
 */

import { ROOT_ID } from './constants.js';
import { childrenOf, collectMainPath } from './tree.js';

// Builds the main line as row items: one full move per row. A move with
// alternatives gets one 'fork' item right after it, holding a 'variation'
// item per alternative. A fork spans the full row width, so the next row
// after it always starts fresh.
function buildMainLine(nodes, rootChildren, nodeIds, parentId, whiteToMove, moveNum, currentId) {
    const items = [];
    let row = { kind: 'row', num: moveNum, white: whiteToMove ? null : { placeholder: true }, black: null };
    items.push(row);

    nodeIds.forEach((id, i) => {
        const node = nodes[id];
        const parentForThis = i === 0 ? parentId : nodeIds[i - 1];
        const kids          = childrenOf(nodes, rootChildren, parentForThis);
        const hasVariation  = kids.length > 1;

        if (whiteToMove) row.white = { node, isCurrent: node.id === currentId };
        else row.black = { node, isCurrent: node.id === currentId };

        const wasWhite    = whiteToMove;
        const thisMoveNum = moveNum;
        if (!whiteToMove) moveNum++;
        whiteToMove = !whiteToMove;

        if (hasVariation) {
            items.push({
                kind: 'fork',
                variations: kids.slice(1).map((startId, v) => ({
                    kind: 'variation', startId, whiteToMove: wasWhite, moveNum: thisMoveNum, depth: 1,
                    more: [v < kids.length - 2],
                })),
            });
        }

        // A white move with no variation continues into this row's
        // still-empty black cell; anything else starts a fresh row.
        const continuesRow = wasWhite && !hasVariation;
        if (i !== nodeIds.length - 1 && !continuesRow) {
            row = { kind: 'row', num: moveNum, white: whiteToMove ? null : { placeholder: true }, black: null };
            items.push(row);
        }
    });
    return items;
}

// Branch connectors of a variation line. `more[i]` tells whether the line
// at depth i + 1 has a later sibling. That line's vertical connector runs
// through the line itself and through every line nested in it, and the line
// also carries the horizontal stub: a 'tee' when a sibling follows, an
// 'elbow' when it is the last one.
function lineBranches(more) {
    const branches = [];
    more.forEach((hasNext, i) => {
        if (i === more.length - 1) branches.push({ level: i + 1, kind: hasNext ? 'tee' : 'elbow' });
        else if (hasNext) branches.push({ level: i + 1, kind: 'through' });
    });
    return branches;
}

// True when the line from `id` branches within `maxDepth` plies or is longer.
function hasBranching(nodes, id, maxDepth) {
    const kids = nodes[id].children;
    return maxDepth <= 0 || kids.length > 1 || (kids.length === 1 && hasBranching(nodes, kids[0], maxDepth - 1));
}

// Two alternatives where the second is a short plain line are shown inline,
// in parentheses; any other fork gets a nested line per alternative.
function isParenthetical(nodes, kids) {
    return kids.length === 2 && !hasBranching(nodes, kids[1], 6);
}

// Move chips of a plain line, each white move (and the first move) numbered.
function plainChips(nodes, startId, whiteToMove, moveNum, currentId) {
    const chips = [];
    collectMainPath(nodes, startId).forEach((id, i) => {
        if (whiteToMove || i === 0) chips.push({ kind: 'num', text: moveNum + (whiteToMove ? '.' : '…') });
        chips.push({ kind: 'move', node: nodes[id], isCurrent: id === currentId });
        if (!whiteToMove) moveNum++;
        whiteToMove = !whiteToMove;
    });
    return chips;
}

// Builds one variation line from `startId`: a paragraph holding its moves up
// to the first fork. A short second alternative is placed inline after the
// move it replaces. Any other fork ends the paragraph, and each of its
// alternatives, the continuation included, becomes a 'variation' item one
// level deeper.
export function buildVariation(nodes, startId, whiteToMove, moveNum, currentId, depth, more) {
    const para = { kind: 'para', depth, chips: [], branches: lineBranches(more) };
    const items = [para];
    let pendingInline = null;
    let id = startId;
    let first = true;

    while (id !== null && id !== undefined) {
        const node = nodes[id];
        if (whiteToMove || first) para.chips.push({ kind: 'num', text: moveNum + (whiteToMove ? '.' : '…') });
        para.chips.push({ kind: 'move', node, isCurrent: id === currentId });
        if (pendingInline) {
            para.chips.push(pendingInline);
            pendingInline = null;
        }
        if (!whiteToMove) moveNum++;
        whiteToMove = !whiteToMove;
        first = false;

        const kids = node.children;
        if (kids.length < 2) {
            id = kids.length ? kids[0] : null;
        } else if (isParenthetical(nodes, kids)) {
            pendingInline = { kind: 'inline', chips: plainChips(nodes, kids[1], whiteToMove, moveNum, currentId) };
            id = kids[0];
        } else {
            kids.forEach((kid, k) => items.push({
                kind: 'variation', startId: kid, whiteToMove, moveNum, depth: depth + 1,
                more: [...more, k < kids.length - 1],
            }));
            id = null;
        }
    }
    return items;
}

export function buildMoveListItems(nodes, rootChildren, currentId, turn, fullmove) {
    if (!rootChildren || rootChildren.length === 0) return [];
    const mainPath = collectMainPath(nodes, rootChildren[0]);
    return buildMainLine(nodes, rootChildren, mainPath, ROOT_ID, turn === 'w', fullmove, currentId);
}
