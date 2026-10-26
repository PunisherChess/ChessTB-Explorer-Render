/** ResultsPanel.jsx: ranked move tables for DTZ, DTC, DTM, and DTM50 */

import { memo, useEffect, useRef } from 'react';
import { Tablebase } from '../engine/tablebase.js';
import { METRICS } from '../engine/constants.js';
import { initMovesGutterSync } from '../engine/scroll.js';
import Button from './ui/Button.jsx';
import Panel from './ui/Panel.jsx';
import Segmented from './ui/Segmented.jsx';

const METRIC_IDS = Object.keys(METRICS);
const METRIC_OPTIONS = METRIC_IDS.map(m => ({ value: m, label: METRICS[m].label }));

// Header text of each metric's score column (default 'Score').
const SCORE_HEADER = { dtc: 'Score/Order' };

const COLUMN_CLASSES = [
    'col-rank',
    ...METRIC_IDS.flatMap(m => [`group-${m} col-move`, `group-${m} col-score`]),
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

function Cell({ cell }) {
    const props = { className: cell.className };
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

function AutoplayButton({ metric, autoplayMetric, autoplayAvailability, actions }) {
    const info = autoplayAvailability[metric];
    const isPlaying = autoplayMetric === metric;
    return (
        <button id={`autoplay-btn-${metric}`} className={`btn btn--col-autoplay${isPlaying ? ' is-playing' : ''}`}
                disabled={info.disabled}
                title={isPlaying ? `Stop ${METRICS[metric].label} auto-play` : info.title}
                aria-label={`Auto-play best ${METRICS[metric].label} move`}
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

function ResultsPanel({ tb, activeMetric, setActiveMetric, autoplayMetric, autoplayAvailability, actions }) {
    const tbodyRef = useRef(null);

    useEffect(() => Tablebase.attachTableEvents(tbodyRef.current), []);

    useEffect(() => initMovesGutterSync(), []);

    useEffect(() => {
        Tablebase.notifyTableRendered();
    }, [tb.rows, tb.rootRow]);

    const rankDigits = Math.max(2, String(tb.rows.reduce((max, row) => Math.max(max, row.rank), 0)).length);

    return (
        <Panel
            className={`results-panel${tb.pending ? ' is-pending' : ''}${tb.loading ? ' is-loading' : ''}`}
            label="Tablebase results" title="Tablebase Result"
            start={
                <div className="probe-status" style={{ display: tb.progress.visible ? 'flex' : 'none' }}>
                    <span id="probe-progress-label" className="probe-progress-label" aria-live="polite">{tb.progress.label}</span>
                    <div id="probe-progress" className={`probe-progress${tb.progress.pct === null ? ' is-indeterminate' : ''}`} aria-hidden="true">
                        <div className="probe-progress__fill" style={{ width: tb.progress.pct === null ? undefined : `${tb.progress.pct}%` }}></div>
                    </div>
                </div>
            }
            end={
                <>
                    <span id="move-count" className="panel-header__count" aria-live="polite" aria-atomic="true">{tb.moveCount}</span>
                    <Button id="export-btn" compact iconOnly icon="download" title="Download move table as CSV" onClick={actions.exportCsv}>CSV</Button>
                </>
            }
        >
            <Segmented
                className="metric-tabs" itemClassName="metric-tab" variant="tabs" label="Tablebase metric"
                options={METRIC_OPTIONS} value={activeMetric} onChange={setActiveMetric}
            />

            <div className="moves-view" style={{ '--rank-digits': rankDigits }}>
                <div className="moves-head">
                    <table className="moves-table moves-table--head" data-active-metric={activeMetric}>
                        <MetricColGroup />
                        <thead>
                            <tr className="group-row">
                                <th></th>
                                {METRIC_IDS.map(m => (
                                    <th key={m} id={`th-${m}-grp`} className={`group-${m}`} colSpan={2}>
                                        <span className="group-row-inner">
                                            <span className="group-label">{METRICS[m].label}</span>
                                            <AutoplayButton metric={m} autoplayMetric={autoplayMetric} autoplayAvailability={autoplayAvailability} actions={actions} />
                                        </span>
                                    </th>
                                ))}
                            </tr>
                            <tr className="col-row">
                                <th id="th-rank" className="col-rank" scope="col" aria-label="Rank">#</th>
                                {METRIC_IDS.flatMap(m => [
                                    <th key={`${m}-move`} id={`th-${m}-move`} className={`group-${m} col-move`} scope="col">Move</th>,
                                    <th key={`${m}-score`} id={`th-${m}-score`} className={`group-${m} col-score`} scope="col">{SCORE_HEADER[m] ?? 'Score'}</th>,
                                ])}
                            </tr>
                            <tr id="root-row" className={`root-row${tb.rootRow ? '' : ' is-hidden'}`}>
                                <td className="col-rank"></td>
                                {(tb.rootRow?.cells ?? []).map((cell, idx) => <Cell key={idx} cell={cell} />)}
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
                                    {row.cells.map((cell, idx) => <Cell key={idx} cell={cell} />)}
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <div id="moves-empty-state" className="moves-empty-state" style={{ display: tb.emptyState ? 'flex' : 'none' }} aria-live="polite">
                        <span className="moves-empty-state__icon" aria-hidden="true">♟</span>
                        <p>{tb.emptyMessage}</p>
                    </div>
                </div>
            </div>
        </Panel>
    );
}

export default memo(ResultsPanel);
