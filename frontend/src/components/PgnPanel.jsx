import { memo, useEffect, useMemo, useRef } from 'react';
import { parseFenMeta } from '../engine/pgnFormat.js';
import { buildMoveListItems, buildVariation } from '../engine/moveLine.js';
import { scrollIntoViewWithin } from '../engine/scroll.js';
import Button from './ui/Button.jsx';
import Panel from './ui/Panel.jsx';

function MoveButton({ node, isCurrent, chip, onGoTo }) {
    const cls = `move-line__move${chip ? ' move-line__move--chip' : ''}${isCurrent ? ' is-current' : ''}`;
    return <button className={cls} onClick={onGoTo ? () => onGoTo(node.id) : undefined}>{node.san}</button>;
}

function renderItems(items, nodes, rootChildren, currentId, onGoTo, keyPrefix) {
    return items.flatMap((item, idx) => {
        const key = `${keyPrefix}-${idx}`;
        if (item.kind === 'row') {
            const whiteEmpty = !item.white || item.white.placeholder;
            return [
                <div className="move-line__row" key={key}>
                    <span className="move-line__num">{item.num}.</span>
                    <span
                        className={`move-line__cell move-line__cell--white${whiteEmpty ? ' move-line__cell--empty' : ''}${item.white?.placeholder ? ' move-line__cell--placeholder' : ''}${item.white?.isCurrent ? ' is-current' : ''}`}
                        onClick={item.white && !item.white.placeholder ? () => onGoTo(item.white.node.id) : undefined}
                    >
                        {item.white?.placeholder ? '...' : null}
                        {item.white && !item.white.placeholder && <MoveButton node={item.white.node} isCurrent={item.white.isCurrent} />}
                    </span>
                    <span
                        className={`move-line__cell move-line__cell--black${!item.black ? ' move-line__cell--empty' : ''}${item.black?.isCurrent ? ' is-current' : ''}`}
                        onClick={item.black ? () => onGoTo(item.black.node.id) : undefined}
                    >
                        {item.black && <MoveButton node={item.black.node} isCurrent={item.black.isCurrent} />}
                    </span>
                </div>,
            ];
        }
        if (item.kind === 'para') {
            return [
                <div className="move-line__variation" key={key} style={{ paddingLeft: `${1.5 * item.depth}rem` }}>
                    {item.chips.map((chip, ci) => chip.kind === 'num'
                        ? <span className="move-line__num move-line__num--inline" key={ci}>{chip.text}</span>
                        : <MoveButton key={ci} node={chip.node} isCurrent={chip.isCurrent} chip onGoTo={onGoTo} />)}
                </div>,
            ];
        }
        // 'variation' marker - expand lazily so nested forks don't need to
        // be walked until they're actually reached.
        const varItems = buildVariation(nodes, rootChildren, item.nodeIds, item.whiteToMove, item.moveNum, currentId, item.depth);
        return renderItems(varItems, nodes, rootChildren, currentId, onGoTo, `${key}-v`);
    });
}

function PgnPanel({ moveHistory, startFen, historyInitialized, actions }) {
    const { nodes, currentId } = moveHistory;
    const scrollRef = useRef(null);

    useEffect(() => {
        const container = scrollRef.current;
        const current = container?.querySelector('.is-current');
        scrollIntoViewWithin(current, container);
    }, [currentId, nodes]);

    // Memo key is `moveHistory`: the board passes a new object on every tree change.
    const content = useMemo(() => {
        if (!historyInitialized) return null;   // no render until the board bootstrap has finished
        const { nodes: treeNodes, rootChildren, currentId: current } = moveHistory;
        if (!rootChildren || rootChildren.length === 0) {
            return <span className="move-line__empty">No moves yet</span>;
        }
        const { turn, fullmove } = parseFenMeta(startFen);
        const items = buildMoveListItems(treeNodes, rootChildren, current, turn, fullmove);
        return renderItems(items, treeNodes, rootChildren, current, actions.goToNode, 'm');
    }, [historyInitialized, moveHistory, startFen, actions]);

    return (
        <Panel
            className="pgn-panel" label="Game PGN" title="PGN"
            end={
                <>
                    <Button id="pgn-btn" compact icon="fileIn" title="Import PGN" aria-label="Import PGN" onClick={actions.openPgnDialog}><span className="btn__label">Import</span></Button>
                    <Button id="pgn-export-btn" compact icon="fileOut" title="Export PGN" aria-label="Export PGN" onClick={actions.exportPgn}><span className="btn__label">Export</span></Button>
                </>
            }
        >
            <div className="pgn-moves-scroll" role="region" aria-label="Move history" tabIndex={0} ref={scrollRef}>
                <div id="move-line" className="move-line" role="group" aria-label="Played moves">
                    {content}
                </div>
            </div>
        </Panel>
    );
}

export default memo(PgnPanel);
