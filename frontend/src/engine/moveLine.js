/**
 * moveLine.js: move-tree → render items
 *
 * Walks the branching move tree the same way the PGN exporter does (see
 * pgnFormat.js's childrenOf/collectMainPath) and produces a flat list of
 * render items for the move-list panel: 'row' items for the main line's
 * Rank/White/Black grid, and 'variation' items for parenthesised
 * alternatives, each carrying enough to expand into its own paragraph
 * without re-walking the tree.
 */

import { ROOT_ID, childrenOf, collectMainPath } from './pgnFormat.js';

// Builds the main line as row items: one full move per row. A move with
// alternatives gets a 'variation' item right after it instead of packed
// into its own cell - since a variation spans the full row width, the
// next row after it always starts fresh.
export function buildMainLine(nodes, rootChildren, nodeIds, parentId, whiteToMove, moveNum, currentId) {
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
            for (let v = 1; v < kids.length; v++) {
                const varPath = collectMainPath(nodes, kids[v]);
                items.push({ kind: 'variation', nodeIds: varPath, whiteToMove: wasWhite, moveNum: thisMoveNum, depth: 1 });
            }
        }

        if (i !== nodeIds.length - 1) {
            if (wasWhite && !hasVariation) {
                // continues into this row's still-empty black cell
            } else {
                row = { kind: 'row', num: moveNum, white: whiteToMove ? null : { placeholder: true }, black: null };
                items.push(row);
            }
        }
    });
    return items;
}

// Builds one variation's body as a sequence of paragraphs (chip lists):
// a move within it that itself has alternatives interrupts the paragraph:
// the nested variation(s) become their own, more deeply indented items,
// and this variation's remaining moves continue in a fresh paragraph at
// the same depth.
export function buildVariation(nodes, rootChildren, nodeIds, whiteToMove, moveNum, currentId, depth) {
    const items = [];
    let para = { kind: 'para', depth, chips: [] };
    items.push(para);

    nodeIds.forEach((id, i) => {
        const node = nodes[id];
        // i === 0 is the move that spawned this variation body - its
        // siblings were already enumerated by the caller as separate
        // variation items, so this doesn't re-derive them here.
        const parentForThis = i === 0 ? null : nodeIds[i - 1];
        const kids          = parentForThis !== null ? childrenOf(nodes, rootChildren, parentForThis) : null;
        const hasVariation  = !!(kids && kids.length > 1);

        if (whiteToMove || i === 0) {
            para.chips.push({ kind: 'num', text: moveNum + (whiteToMove ? '.' : '…') });
        }
        para.chips.push({ kind: 'move', node, isCurrent: node.id === currentId });

        const wasWhite    = whiteToMove;
        const thisMoveNum = moveNum;
        if (!whiteToMove) moveNum++;
        whiteToMove = !whiteToMove;

        if (hasVariation) {
            for (let v = 1; v < kids.length; v++) {
                const varPath = collectMainPath(nodes, kids[v]);
                items.push({ kind: 'variation', nodeIds: varPath, whiteToMove: wasWhite, moveNum: thisMoveNum, depth: depth + 1 });
            }
            if (i !== nodeIds.length - 1) {
                para = { kind: 'para', depth, chips: [] };
                items.push(para);
            }
        }
    });
    return items;
}

export function buildMoveListItems(nodes, rootChildren, currentId, turn, fullmove) {
    if (!rootChildren || rootChildren.length === 0) return [];
    const mainPath = collectMainPath(nodes, rootChildren[0]);
    return buildMainLine(nodes, rootChildren, mainPath, ROOT_ID, turn === 'w', fullmove, currentId);
}
