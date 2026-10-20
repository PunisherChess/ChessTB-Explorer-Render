/**
 * tree.js: move-tree helpers
 *
 * Shared by board.js (which owns the tree), the move-list panel
 * (moveLine.js), and the PGN exporter (pgnFormat.js), so the three cannot
 * disagree about where a variation forks.
 */

import { ROOT_ID } from './constants.js';

export function childrenOf(nodes, rootChildren, id) {
    return id === ROOT_ID ? rootChildren : nodes[id].children;
}

// Follows children[0] repeatedly from startId - one line's worth of node
// ids (its own "main" continuation).
export function collectMainPath(nodes, startId) {
    const ids = [];
    let cur = startId;
    while (cur !== null && cur !== undefined) {
        ids.push(cur);
        const kids = nodes[cur].children;
        cur = kids.length ? kids[0] : null;
    }
    return ids;
}
