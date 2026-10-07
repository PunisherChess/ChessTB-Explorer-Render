import { useEffect, useRef } from 'react';
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

export default function PgnPanel({ explorer }) {
    const { moveHistory, startFen, historyInitialized, actions } = explorer;
    const { nodes, rootChildren, currentId } = moveHistory;
    const scrollRef = useRef(null);

    useEffect(() => {
        const container = scrollRef.current;
        const current = container?.querySelector('.is-current');
        scrollIntoViewWithin(current, container);
    }, [currentId, nodes]);

    let content = null;
    if (!historyInitialized) {
        content = null;   // no render until Board reports its first move-tree change
    } else if (!rootChildren || rootChildren.length === 0) {
        content = <span className="move-line__empty">No moves yet</span>;
    } else {
        const { turn, fullmove } = parseFenMeta(startFen);
        const items = buildMoveListItems(nodes, rootChildren, currentId, turn, fullmove);
        content = renderItems(items, nodes, rootChildren, currentId, actions.goToNode, 'm');
    }

    return (
        <Panel
            className="pgn-panel" label="Game PGN" title="PGN"
            end={
                <>
                    <Button id="pgn-copy-btn" compact title="Copy PGN to clipboard" onClick={() => actions.copyPgnText()}>Copy</Button>
                    <Button id="pgn-btn" compact icon="upload" title="Import PGN game" onClick={() => actions.openPgnDialog()}>Import</Button>
                </>
            }
        >
            <div className="pgn-moves-scroll" role="region" aria-label="Move history" tabIndex={0} ref={scrollRef}>
                <div id="move-line" className="move-line" role="list" aria-label="Played moves">
                    {content}
                </div>
            </div>
        </Panel>
    );
}
