import { useEffect, useRef } from 'react';
import { Tablebase } from '../engine/tablebase.js';
import { initMovesGutterSync } from '../engine/scroll.js';
import Button from './ui/Button.jsx';
import Panel from './ui/Panel.jsx';
import Segmented from './ui/Segmented.jsx';

const METRICS = ['dtz', 'dtc', 'dtm', 'dtm50'];
const METRIC_LABEL = { dtz: 'DTZ', dtc: 'DTC', dtm: 'DTM', dtm50: 'DTM50' };
const METRIC_OPTIONS = METRICS.map(m => ({ value: m, label: METRIC_LABEL[m] }));

const COLUMN_CLASSES = [
    'col-rank',
    'group-dtz col-move', 'group-dtz col-score',
    'group-dtc col-move', 'group-dtc col-score',
    'group-dtm col-move', 'group-dtm col-score',
    'group-dtm50 col-move', 'group-dtm50 col-score',
];

function MetricColGroup() {
    return (
        <colgroup>
            {COLUMN_CLASSES.map(cls => <col key={cls} className={cls} />)}
        </colgroup>
    );
}

function DotIcon({ prefix }) {
    return (
        <svg viewBox="0 0 16 16" aria-hidden="true" className={`${prefix}__icon`}>
            <circle cx="8" cy="8" r="8" className={`${prefix}__bg`} />
            <circle cx="8" cy="4.3" r="1.05" className={`${prefix}__mark`} />
            <rect x="7.1" y="6.5" width="1.8" height="6.2" rx="0.9" className={`${prefix}__mark`} />
        </svg>
    );
}

function Cell({ cell, idx }) {
    const props = { key: idx, className: cell.className };
    if (cell.title) props.title = cell.title;
    if (cell.headers) props.headers = cell.headers;
    if (cell.interactive) {
        props['data-san'] = cell.dataSan;
        props['data-child-fen'] = cell.dataChildFen || '';
        props.tabIndex = 0;
        props.role = 'button';
        props['aria-label'] = `Play ${cell.dataSan}`;
    }
    if (cell.kind === 'score') {
        if (cell.outcome !== undefined) props['data-outcome'] = cell.outcome;
        return (
            <td {...props}>
                {cell.text}
                {cell.warning && <span className="warning-dot" title={cell.warning}><DotIcon prefix="warning-dot" /></span>}
                {cell.info && <span className="info-dot" title={cell.info}><DotIcon prefix="info-dot" /></span>}
            </td>
        );
    }
    return <td {...props}>{cell.text}</td>;
}

function AutoplayButton({ metric, explorer }) {
    const { autoplayMetric, autoplayAvailability, actions } = explorer;
    const info = autoplayAvailability[metric];
    const isPlaying = autoplayMetric === metric;
    return (
        <button id={`autoplay-btn-${metric}`} className={`btn btn--col-autoplay${isPlaying ? ' is-playing' : ''}`}
                disabled={info.disabled}
                title={isPlaying ? `Stop ${METRIC_LABEL[metric]} auto-play` : info.title}
                aria-label={`Auto-play best ${METRIC_LABEL[metric]} move`}
                onClick={() => actions.toggleAutoPlay(metric)}>
            <svg className="autoplay-icon autoplay-icon--play" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 2.1 L9.6 6 L3 9.9 Z" />
            </svg>
            <svg className="autoplay-icon autoplay-icon--stop" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1" />
            </svg>
        </button>
    );
}

export default function ResultsPanel({ explorer }) {
    const { tb, activeMetric, actions } = explorer;
    const tbodyRef = useRef(null);
    const cleanupRef = useRef(null);

    useEffect(() => {
        cleanupRef.current = Tablebase.attachTableEvents(tbodyRef.current);
        return () => cleanupRef.current?.();
    }, []);

    useEffect(() => initMovesGutterSync(), []);

    useEffect(() => {
        Tablebase.notifyTableRendered();
    }, [tb.rows, tb.rootRow]);

    return (
        <Panel
            className={`results-panel${tb.loading ? ' is-loading' : ''}`}
            label="Tablebase results" title="Tablebase Result"
            start={
                <>
                    <span id="probe-progress-label" className="probe-progress-label" aria-live="polite">{tb.progress.label}</span>
                    <div id="probe-progress" className="probe-progress" style={{ display: tb.progress.visible ? 'block' : 'none' }} aria-hidden="true">
                        <div className="probe-progress__fill" style={{ width: `${tb.progress.pct}%` }}></div>
                    </div>
                </>
            }
            end={
                <>
                    <span id="move-count" className="panel-header__count" aria-live="polite" aria-atomic="true">{tb.moveCount}</span>
                    <Button id="export-btn" compact iconOnly icon="download" title="Download move table as CSV" onClick={() => actions.exportCsv()}>CSV</Button>
                </>
            }
        >
            <Segmented
                className="metric-tabs" itemClassName="metric-tab" variant="tabs" label="Tablebase metric"
                options={METRIC_OPTIONS} value={activeMetric} onChange={actions.setActiveMetric}
            />

            <div className="moves-view">
                <div className="moves-head">
                    <table className="moves-table moves-table--head" data-active-metric={activeMetric}>
                        <MetricColGroup />
                        <thead>
                            <tr className="group-row">
                                <th></th>
                                {METRICS.map(m => (
                                    <th key={m} id={`th-${m}-grp`} className={`group-${m}`} colSpan={2}>
                                        <span className="group-row-inner">
                                            <span className="group-label">{METRIC_LABEL[m]}</span>
                                            <AutoplayButton metric={m} explorer={explorer} />
                                        </span>
                                    </th>
                                ))}
                            </tr>
                            <tr className="col-row">
                                <th id="th-rank" className="col-rank" scope="col" aria-label="Rank">#</th>
                                <th id="th-dtz-move" className="group-dtz col-move" scope="col">Move</th>
                                <th id="th-dtz-score" className="group-dtz col-score" scope="col">Score</th>
                                <th id="th-dtc-move" className="group-dtc col-move" scope="col">Move</th>
                                <th id="th-dtc-score" className="group-dtc col-score" scope="col">Score/Order</th>
                                <th id="th-dtm-move" className="group-dtm col-move" scope="col">Move</th>
                                <th id="th-dtm-score" className="group-dtm col-score" scope="col">Score</th>
                                <th id="th-dtm50-move" className="group-dtm50 col-move" scope="col">Move</th>
                                <th id="th-dtm50-score" className="group-dtm50 col-score" scope="col">Score</th>
                            </tr>
                            <tr id="root-row" className={`root-row${tb.rootRow ? '' : ' is-hidden'}`}>
                                <td className="col-rank"></td>
                                {(tb.rootRow?.cells ?? []).map((cell, idx) => <Cell key={idx} cell={cell} idx={idx} />)}
                            </tr>
                        </thead>
                    </table>
                </div>

                <div className="moves-body-scroll" role="region" aria-label="Move rankings" tabIndex={0}>
                    <table className="moves-table moves-table--body" data-active-metric={activeMetric} aria-label="Moves ranked by tablebase metric">
                        <caption className="sr-only">
                            When Show Root Row is enabled in Settings, the current position&apos;s own score is shown
                            first, followed by legal moves ranked by Distance to Zeroing, Distance to Conversion,
                            Distance to Mate, and Distance to Mate with the 50-move rule
                        </caption>
                        <MetricColGroup />
                        <tbody id="moves-tbody" ref={tbodyRef}>
                            {tb.rows.map(row => (
                                <tr key={row.rank}>
                                    <td className="col-rank" headers="th-rank">{row.rank}</td>
                                    {row.cells.map((cell, idx) => <Cell key={idx} cell={cell} idx={idx} />)}
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <div id="moves-empty-state" className="moves-empty-state" style={{ display: tb.emptyState ? 'flex' : 'none' }} aria-live="polite">
                        <span className="moves-empty-state__icon" aria-hidden="true">♟</span>
                        <p>Probe a position to see the tablebase ranking of each legal move.</p>
                    </div>
                </div>
            </div>
        </Panel>
    );
}
