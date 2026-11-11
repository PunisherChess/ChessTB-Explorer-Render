/** PgnPanel.jsx: move-history panel with PGN import and export buttons */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseFenMeta } from '../engine/pgnFormat.js';
import { buildMoveListItems, buildVariation } from '../engine/moveLine.js';
import { scrollIntoViewWithin } from '../engine/scroll.js';
import Button from './ui/Button.jsx';
import Panel from './ui/Panel.jsx';

function MoveButton({ node, isCurrent, chip, onGoTo }) {
    const cls = `move-line__move${chip ? ' move-line__move--chip' : ''}${isCurrent ? ' is-current' : ''}`;
    return <button className={cls} onClick={onGoTo ? () => onGoTo(node.id) : undefined}>{node.san}</button>;
}

function renderChip(chip, key, onGoTo) {
    if (chip.kind === 'num') return <span className="move-line__num move-line__num--inline" key={key}>{chip.text}</span>;
    if (chip.kind === 'inline') {
        return <span className="move-line__inline" key={key}>{chip.chips.map((c, i) => renderChip(c, i, onGoTo))}</span>;
    }
    return <MoveButton key={key} node={chip.node} isCurrent={chip.isCurrent} chip onGoTo={onGoTo} />;
}

const variationLines = group => Array.from(group.children)
    .filter(child => child.classList.contains('move-line__variation'));

// Draws the branch connectors of a variation group as one SVG path.
function VariationGroup({ children }) {
    const groupRef = useRef(null);
    const [geometry, setGeometry] = useState(null);

    useLayoutEffect(() => {
        const group = groupRef.current;
        if (!group) return undefined;

        const measure = () => {
            const width = group.clientWidth;
            const height = group.clientHeight;
            if (!width || !height) {
                setGeometry(previous => previous?.width === width && previous?.height === height
                    ? previous : { width, height, path: '' });
                return;
            }

            const groupRect = group.getBoundingClientRect();
            const originX = groupRect.left + group.clientLeft;
            const originY = groupRect.top + group.clientTop;
            const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            const branchStep = rootFontSize * 1.5;
            const branchInset = rootFontSize * 0.625;
            const stubWidth = rootFontSize * 0.5;
            const fmt = value => Number(value.toFixed(3)).toString();
            const paths = [];

            variationLines(group).forEach(line => {
                const depth = Number.parseInt(line.dataset.depth, 10);
                if (!depth) return;

                const rect = line.getBoundingClientRect();
                const style = getComputedStyle(line);
                const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
                const paddingTop = Number.parseFloat(style.paddingTop) || 0;
                const fontSize = Number.parseFloat(style.fontSize) || 12;
                const top = rect.top - originY;
                const bottom = rect.bottom - originY;
                const junctionY = top + paddingTop + fontSize * 0.8;
                const firstBranchX = rect.left - originX + paddingLeft - branchInset;
                const branchData = (line.dataset.branches || '').trim();

                branchData.split(/\s+/).filter(Boolean).forEach(entry => {
                    const [levelText, kind] = entry.split(':');
                    const level = Number.parseInt(levelText, 10);
                    if (!level || level > depth) return;
                    const x = firstBranchX - (depth - level) * branchStep;
                    const xCenter = x + 0.5;
                    const xEnd = x + stubWidth;
                    const sx = fmt(xCenter);
                    const sy = fmt(top);
                    const ey = fmt(bottom);
                    const jy = fmt(junctionY);
                    const ex = fmt(xEnd);

                    if (kind === 'through') {
                        paths.push(`M ${sx} ${sy} V ${ey}`);
                    } else if (kind === 'tee') {
                        paths.push(`M ${sx} ${sy} V ${jy} H ${ex} M ${sx} ${jy} V ${ey}`);
                    } else if (kind === 'elbow') {
                        paths.push(`M ${sx} ${sy} V ${jy} H ${ex}`);
                    }
                });
            });

            const path = paths.join(' ');
            setGeometry(previous => previous?.width === width && previous?.height === height && previous?.path === path
                ? previous : { width, height, path });
        };

        measure();

        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(measure)
            : null;
        resizeObserver?.observe(group);
        variationLines(group).forEach(line => resizeObserver?.observe(line));
        window.addEventListener('resize', measure, { passive: true });

        return () => {
            resizeObserver?.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [children]);

    return (
        <div className="move-line__variations" ref={groupRef}>
            {geometry?.path && (
                <svg
                    className="move-line__connectors"
                    viewBox={`0 0 ${geometry.width} ${geometry.height}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    focusable="false"
                >
                    <path d={geometry.path} />
                </svg>
            )}
            {children}
        </div>
    );
}

function renderItems(items, nodes, currentId, onGoTo, keyPrefix) {
    return items.flatMap((item, idx) => {
        const key = `${keyPrefix}-${idx}`;
        if (item.kind === 'row') {
            const whiteEmpty = !item.white || item.white.placeholder;
            return [
                <div className="move-line__row" key={key}>
                    <span className="move-line__num">{item.num}</span>
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
        if (item.kind === 'fork') {
            return [
                <VariationGroup key={key}>
                    {renderItems(item.variations, nodes, currentId, onGoTo, `${key}-f`)}
                </VariationGroup>,
            ];
        }
        if (item.kind === 'para') {
            const branches = item.branches.map(branch => `${branch.level}:${branch.kind}`).join(' ');
            return [
                <div
                    className="move-line__variation"
                    key={key}
                    style={{ '--depth': item.depth }}
                    data-depth={item.depth}
                    data-branches={branches}
                >
                    {item.chips.map((chip, ci) => renderChip(chip, ci, onGoTo))}
                </div>,
            ];
        }
        // 'variation' marker - expand lazily so nested forks don't need to
        // be walked until they're reached.
        const varItems = buildVariation(nodes, item.startId, item.whiteToMove, item.moveNum, currentId, item.depth, item.more);
        return renderItems(varItems, nodes, currentId, onGoTo, `${key}-v`);
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
        return renderItems(items, treeNodes, current, actions.goToNode, 'm');
    }, [historyInitialized, moveHistory, startFen, actions]);

    return (
        <Panel
            className="pgn-panel" label="Game PGN" title="PGN"
            end={
                <>
                    <Button id="pgn-btn" compact iconOnly icon="fileIn" title="Import PGN" aria-label="Import PGN" onClick={actions.openPgnDialog} />
                    <Button id="pgn-export-btn" compact iconOnly icon="fileOut" title="Export PGN" aria-label="Export PGN" onClick={actions.exportPgn} />
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
