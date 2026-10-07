/**
 * tablebase.js - /probe/stream SSE client and results state
 *
 * Owns the SSE client for /probe/stream and all state for the four ranked
 * move tables (DTZ / DTC / DTM / DTM50):
 *   - setResultHandler(fn) - callback after each successful probe, used for
 *     auto-play.
 *   - setNoteHandler(fn) - callback with the message of a warning or info
 *     dot tapped with touch or pen input.
 *   - setViewStateHandler(fn) - callback with a plain object describing
 *     everything the results panel needs to render (loading/progress/error,
 *     the Root row, and the ranked move rows). Rendering itself is the
 *     caller's responsibility; this module never touches the DOM to draw
 *     the table.
 *   - attachTableEvents(tbody) - wires click-to-play, hover pairing, and
 *     hover-triggered prefetch onto the actual rendered <tbody>. Returns a
 *     cleanup function.
 *   - Prefetch on hover: warms the cache for the child position of a
 *     hovered move.
 *   - The Root row: the current position's own score for each metric,
 *     included in the view state ahead of the ranked child moves when the
 *     "Show Root Row" setting is on (see setShowRootRow/getShowRootRow).
 *   - A coverage indicator: distinct state when error_code === "missing_table".
 *   - An info flag on draws by insufficient material, and a warning flag on
 *     a cursed win / blessed loss outcome - both carry a tooltip string for
 *     the caller to render. The warning tooltip has a second line when the
 *     DTZ score is rounded.
 *   - CSV export of the current move table.
 *   - A result cache keyed by (variant, FEN), so revisiting an already-
 *     probed position reuses the cached result instead of issuing a new
 *     /probe/stream call.
 */

import { Board, VARIANTS } from './board.js';
import * as Storage        from './storage.js';

// ── Bounded LRU cache ────────────────────────────────────────────────────
const _MAX_CACHE_ENTRIES = 500;

class _BoundedCache {
    constructor(maxSize) {
        this._maxSize = maxSize;
        this._map = new Map();
    }
    has(key) { return this._map.has(key); }
    get(key) {
        if (!this._map.has(key)) return undefined;
        const value = this._map.get(key);
        this._map.delete(key);
        this._map.set(key, value);   // refresh recency
        return value;
    }
    set(key, value) {
        this._map.delete(key);
        this._map.set(key, value);
        if (this._map.size > this._maxSize) {
            this._map.delete(this._map.keys().next().value);   // evict oldest
        }
    }
    delete(key) { this._map.delete(key); }
}

const Tablebase = (() => {

    let _currentController = null;
    let _probeSeq    = 0;
    let _onMoveSelect = null;
    let _onNote       = null;
    let _onResult     = null;
    let _onViewState  = null;
    let _lastData     = null;
    let _lastFen      = null;     // FEN of the currently-applied results
    let _lastVariant  = null;     // variant the currently-applied results were probed under
    let _prefetchCache = new _BoundedCache(_MAX_CACHE_ENTRIES);   // (variant,child_fen) → probe result data
    let _resultCache   = new _BoundedCache(_MAX_CACHE_ENTRIES);   // (variant,fen) → last probe result

    // Hover-prefetch state - module-scoped so probe() can see and cancel an
    // in-flight prefetch for the exact position it's about to probe itself.
    let _prefetchTimer      = null;
    let _prefetchController = null;   // in-flight prefetch fetch, if any
    let _prefetchKey        = null;   // cache key for the timer/fetch above
    let _prefetchRun        = null;   // identity token for the current pending/in-flight run
    let _prefetchPromise    = null;   // current run's eventual { ok, data|error, aborted } outcome
    let _prefetchAttached   = false;  // true while a probe() call is awaiting _prefetchPromise

    function _cancelPrefetch() {
        clearTimeout(_prefetchTimer);
        _prefetchTimer = null;
        if (_prefetchAttached) return;
        if (_prefetchController) { _prefetchController.abort(); _prefetchController = null; }
        _prefetchKey = null;
        _prefetchRun = null;
        _prefetchPromise = null;
    }

    function _cacheKey(fen, variant) { return `${variant || VARIANTS.STANDARD}\u0000${fen}`; }

    // ── Show Root Row setting ────────────────────────────────────────────
    const _LS_SHOW_ROOT_ROW = 'chesstb_show_root_row';
    function _readShowRootRowPref() { return Storage.read(_LS_SHOW_ROOT_ROW) === 'true'; }
    let _showRootRow = _readShowRootRowPref();

    const _ROOT_LABEL = 'Root';

    // ── WDL / formatting helpers ─────────────────────────────────────────
    function _wdlToOutcome(wdl) {
        return { 2:'win', 1:'cursed_win', 0:'draw', '-1':'blessed_loss', '-2':'loss' }[wdl] ?? 'unknown';
    }
    function _plural(n) { return Math.abs(n) === 1 ? 'ply' : 'plies'; }
    function _pliesText(n) {
        const a = Math.abs(n);
        return `${a} ${_plural(a)}`;
    }
    function _isWin(o)  { return o === 'win'  || o === 'cursed_win'; }
    function _isLoss(o) { return o === 'loss' || o === 'blessed_loss'; }
    function _dtcRootRaw(data) {
        return {
            san: _ROOT_LABEL,
            plies: data.dtc_available ? data.dtc[2] : 0,
            order: data.dtc_available ? data.dtc[1] : 0,
            outcome: data.dtc_available ? _wdlToOutcome(data.dtc[0]) : 'not_available',
            available: data.dtc_available,
        };
    }
    function _csvPlies(entry) { return entry.available === false ? 'N/A' : entry.plies; }

    function _isPawnless(fen) {
        if (!fen) return false;
        return !/[Pp]/.test(fen.split(' ')[0]);
    }

    function _dtcDisplayEntry(entry, ownFen) {
        if (!entry) return null;
        if (!entry.available) return { ...entry, orderText: 'N/A' };
        return _isPawnless(ownFen)
            ? { ...entry, orderText: '-' }
            : { ...entry, orderText: String(entry.order) };
    }

    function _dtcScoreText(entry) {
        const n = Math.abs(entry.plies);
        return `${n} ${_plural(n)}/${entry.orderText}`;
    }

    const _ROUNDED_NOTE = 'Rounded Score — this could be off by 1 ply.';

    function _warningText(entry) {
        const text = entry.outcome === 'cursed_win'
            ? 'Cursed Win — a win in principle, but a draw under the 50-move rule.'
            : entry.outcome === 'blessed_loss'
                ? 'Blessed Loss — a loss in principle, but a draw under the 50-move rule.'
                : null;
        return text && entry.rounded ? `${text}\n${_ROUNDED_NOTE}` : text;
    }

    // ── Cell descriptors ──────────────────────────────────────────────────
    // Same shape/formatting rules as a rendered <td> pair, as plain data;
    // the caller renders these into cells (see ResultsPanel). `metric` and
    // `groupClass` drive the CSS grouping; `interactive` gates whether the
    // cell is clickable/prefetchable (false for the Root row).
    function _createMoveCells(entry, groupClass, withLabel, interactive = true, dtcFormat = false) {
        const metric  = groupClass.slice('group-'.length);
        const headers = interactive
            ? { move: `th-${metric}-grp th-${metric}-move`, score: `th-${metric}-grp th-${metric}-score` }
            : null;
        if (!entry) {
            return [
                { kind: 'move',  className: `${groupClass} col-move is-empty-cell`, headers: headers?.move ?? null, text: '—', title: null, interactive: false },
                { kind: 'score', className: `${groupClass} col-score is-empty-cell`, headers: headers?.score ?? null, text: '—', title: null, interactive: false },
            ];
        }

        let scoreText;
        if (entry.is_mate)                                    scoreText = 'Checkmate';
        else if (entry.draw_reason === 'stalemate')           scoreText = 'Stalemate';
        else if (entry.outcome === 'draw')                    scoreText = 'Draw';
        else if (entry.outcome === 'unknown')                 scoreText = 'Unknown';
        else if (entry.outcome === 'not_available')           scoreText = 'Not Available';
        else if (dtcFormat)                                    scoreText = _dtcScoreText(entry);
        else if (withLabel && _isWin(entry.outcome))          scoreText = `Win in ${_pliesText(entry.plies)}`;
        else if (withLabel && _isLoss(entry.outcome))         scoreText = `Loss in ${_pliesText(entry.plies)}`;
        else                                                   scoreText = _pliesText(entry.plies);

        const moveCell = {
            kind: 'move',
            className: `${groupClass} col-move${interactive ? '' : ' is-root'}`,
            headers: headers?.move ?? null,
            text: entry.san,
            title: entry.san,
            interactive,
            dataSan: interactive ? entry.san : null,
            dataChildFen: interactive ? (entry.child_fen || '') : null,
        };
        const scoreCell = {
            kind: 'score',
            className: `${groupClass} col-score${entry.is_mate ? ' is-mate' : ''}`,
            headers: headers?.score ?? null,
            text: scoreText,
            title: scoreText,
            interactive,
            dataSan: interactive ? entry.san : null,
            dataChildFen: interactive ? (entry.child_fen || '') : null,
            outcome: entry.outcome,
            warning: _warningText(entry),
            info: entry.draw_reason === 'insufficient_material' ? 'Draw by Insufficient Material' : null,
        };
        return [moveCell, scoreCell];
    }

    // ── Root row entries ──────────────────────────────────────────────────
    function _rootEntries(data, fen) {
        const maxRows = Math.max(
            (data.moves_dtz   || []).length,
            (data.moves_dtc   || []).length,
            (data.moves_dtm   || []).length,
            (data.moves_dtm50 || []).length,
        );
        const rootIsMate = maxRows === 0 && data.wdl !== 0;

        const dtzEntry = {
            san: _ROOT_LABEL, plies: data.dtz_available ? data.dtz : 0,
            outcome: data.dtz_available ? _wdlToOutcome(data.wdl) : 'not_available',
            available: data.dtz_available,
            rounded: data.dtz_rounded === true,
            is_mate: rootIsMate, draw_reason: data.draw_reason, child_fen: null,
        };
        const dtcRaw = {
            ..._dtcRootRaw(data),
            is_mate: rootIsMate, draw_reason: data.draw_reason, child_fen: null,
        };
        const dtcEntry = _dtcDisplayEntry(dtcRaw, fen);
        const dtmEntry = {
            san: _ROOT_LABEL, plies: data.dtm_available ? data.dtm : 0,
            outcome: data.dtm_available ? _wdlToOutcome(data.wdl) : 'not_available',
            available: data.dtm_available,
            is_mate: rootIsMate, draw_reason: data.draw_reason, child_fen: null,
        };
        const dtm50Entry = {
            san: _ROOT_LABEL, plies: data.dtm50_available ? data.dtm50[1] : 0,
            outcome: data.dtm50_available ? _wdlToOutcome(data.dtm50[0]) : 'not_available',
            available: data.dtm50_available,
            is_mate: rootIsMate, draw_reason: data.draw_reason, child_fen: null,
        };
        return { dtzEntry, dtcEntry, dtmEntry, dtm50Entry };
    }

    // ── View state ────────────────────────────────────────────────────────
    // Single object describing everything the results panel renders.
    // Rebuilt on every meaningful change and pushed to _onViewState.
    let _viewState = {
        loading: false,
        progress: { visible: false, pct: 0, label: '' },
        error: null,               // { message, isCoverage } | null
        moveCount: '',
        showRootRow: _showRootRow,
        rootRow: null,             // { cells: [...] } | null
        rows: [],                  // [{ rank, cells: [...] }]
        emptyState: true,
    };
    function _publish(patch) {
        _viewState = { ..._viewState, ...patch };
        if (_onViewState) _onViewState(_viewState);
    }

    function _rootRowState(data, fen) {
        if (!_showRootRow) return null;
        if (!data) {
            const cells = ['group-dtz', 'group-dtc', 'group-dtm', 'group-dtm50']
                .flatMap(g => _createMoveCells(null, g, false));
            return { cells };
        }
        const { dtzEntry, dtcEntry, dtmEntry, dtm50Entry } = _rootEntries(data, fen);
        const cells = [
            ..._createMoveCells(dtzEntry,   'group-dtz',   false, false),
            ..._createMoveCells(dtcEntry,   'group-dtc',   false, false, true),
            ..._createMoveCells(dtmEntry,   'group-dtm',   true,  false),
            ..._createMoveCells(dtm50Entry, 'group-dtm50', true,  false),
        ];
        return { cells };
    }

    function _rowsState(movesDtz, movesDtc, movesDtm, movesDtm50) {
        const maxRows = Math.max(movesDtz.length, movesDtc.length, movesDtm.length, movesDtm50.length);
        const rows = [];
        for (let i = 0; i < maxRows; i++) {
            const dtcEntry = _dtcDisplayEntry(movesDtc[i] || null, (movesDtc[i] || {}).child_fen);
            const cells = [
                ..._createMoveCells(movesDtz[i]   || null, 'group-dtz',   false),
                ..._createMoveCells(dtcEntry,               'group-dtc',   false, true, true),
                ..._createMoveCells(movesDtm[i]   || null, 'group-dtm',   true),
                ..._createMoveCells(movesDtm50[i] || null, 'group-dtm50', true),
            ];
            rows.push({ rank: i + 1, cells });
        }
        return rows;
    }

    function _blankResults() {
        _publish({
            rootRow: _rootRowState(null, _lastFen),
            rows: [],
            emptyState: false,
            moveCount: _viewState.moveCount,   // set client-side from the FEN - untouched here
        });
    }

    function _isComplete(data) {
        return !(data && data.summary && data.summary.unknown > 0);
    }

    function _applyResults(data, fen, variant) {
        _lastData    = data;
        _lastFen     = fen;
        _lastVariant = variant;
        if (_isComplete(data)) _resultCache.set(_cacheKey(fen, variant), data);

        const movesDtz   = data.moves_dtz   || [];
        const movesDtc   = data.moves_dtc   || [];
        const movesDtm   = data.moves_dtm   || [];
        const movesDtm50 = data.moves_dtm50 || [];
        const rows = _rowsState(movesDtz, movesDtc, movesDtm, movesDtm50);
        const maxRows = rows.length;

        _publish({
            loading: false,
            rootRow: _rootRowState(data, fen),
            rows,
            emptyState: maxRows === 0,
            moveCount: maxRows > 0 ? `${maxRows} legal move${maxRows === 1 ? '' : 's'}` : '',
        });
        if (_onResult) _onResult(data);
    }

    function _applyCachedResult(data, fen, variant, mySeq) {
        _publish({ loading: true });
        Promise.resolve().then(() => {
            if (mySeq !== _probeSeq) return;
            _applyResults(data, fen, variant);
            _publish({ error: null });
        });
    }

    function _reset() {
        _publish({ loading: false, rootRow: _rootRowState(null, _lastFen), rows: [], emptyState: false, error: null });
        _lastData    = null;
        _lastFen     = null;
        _lastVariant = null;
    }

    function _showCoverageError(errData) {
        const pc   = errData.piece_count;
        const note = pc ? ` (position has ${pc} pieces)` : '';
        _publish({ error: { message: `Not in tablebase${note} — load a tablebase with more piece coverage.`, isCoverage: true } });
    }

    function _handleError(errData, onError) {
        const msg = errData.error || 'Unknown error.';
        const isCoverageError = errData.error_code === 'missing_table';
        if (isCoverageError) {
            _showCoverageError(errData);
        } else {
            _publish({ error: { message: msg, isCoverage: false } });
        }
        if (onError) onError(msg, isCoverageError);
    }

    // ── SSE streaming client ──────────────────────────────────────────────
    async function* _sseEvents(response) {
        if (!response.body) throw { error: 'Network error.' };
        const reader  = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const rawEvent of events) {
                const line = rawEvent.trim();
                if (!line.startsWith('data: ')) continue;
                try { yield JSON.parse(line.slice(6)); } catch { /* skip malformed frame */ }
            }
        }
    }

    async function _probeStream(fen, variant, signal) {
        const response = await fetch('/probe/stream', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ fen, variant }),
            signal,
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Network error.' }));
            throw err;
        }
        for await (const evtData of _sseEvents(response)) {
            if (evtData.status === 'probing') {
                _publish({ progress: { visible: true, pct: evtData.total > 0 ? Math.round((evtData.completed / evtData.total) * 100) : 0, label: evtData.total > 0 ? `Probing ${evtData.completed}/${evtData.total}…` : 'Probing…' } });
            } else if (evtData.status === 'done') {
                return evtData;
            } else if (evtData.status === 'error') {
                throw evtData;
            }
        }
        throw { error: 'Stream ended unexpectedly.' };
    }

    function probe(fen, variant, onError) {
        const mySeq = ++_probeSeq;
        if (_currentController) { _currentController.abort(); _currentController = null; }
        const key = _cacheKey(fen, variant);

        if (_prefetchKey === key) {
            if (_prefetchController && _prefetchPromise) {
                _prefetchAttached = true;
                const waitingOn = _prefetchPromise;
                _blankResults();
                _publish({ loading: true, progress: { visible: true, pct: 0, label: 'Probing…' } });
                waitingOn.then(outcome => {
                    _prefetchAttached = false;
                    if (mySeq !== _probeSeq) return;
                    _publish({ progress: { visible: false, pct: 0, label: '' } });
                    if (outcome.ok) {
                        _applyResults(outcome.data, fen, variant);
                        _publish({ error: null });
                    } else if (!outcome.aborted) {
                        _reset();
                        _handleError(outcome.error && outcome.error.error ? outcome.error : { error: 'Cannot reach backend.' }, onError);
                    }
                });
                return;
            }
            _cancelPrefetch();
        }

        if (_prefetchCache.has(key)) {
            const cached = _prefetchCache.get(key);
            _prefetchCache.delete(key);
            _applyCachedResult(cached, fen, variant, mySeq);
            return;
        }
        if (_resultCache.has(key)) {
            _applyCachedResult(_resultCache.get(key), fen, variant, mySeq);
            return;
        }

        _currentController = new AbortController();
        const myController = _currentController;
        const signal       = myController.signal;

        _blankResults();
        _publish({ loading: true, progress: { visible: true, pct: 0, label: 'Probing…' } });

        _probeStream(fen, variant, signal)
            .then(data => {
                if (mySeq !== _probeSeq) return;
                if (_currentController === myController) _currentController = null;
                _publish({ progress: { visible: false, pct: 0, label: '' } });
                if (data.error) {
                    _reset();
                    _handleError(data, onError);
                } else {
                    _applyResults(data, fen, variant);
                    _publish({ error: null });
                }
            })
            .catch(err => {
                if (err && err.name === 'AbortError') return;
                if (mySeq !== _probeSeq) return;
                if (_currentController === myController) _currentController = null;
                _publish({ progress: { visible: false, pct: 0, label: '' } });
                _reset();
                _handleError(err && err.error ? err : { error: 'Cannot reach backend.' }, onError);
                console.error('[Tablebase]', err);
            });
    }

    // ── CSV export ────────────────────────────────────────────────────────
    function _csvField(value) {
        const s = String(value);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function exportCsv() {
        if (!_lastData) return;
        const dtz   = _lastData.moves_dtz   || [];
        const dtc   = _lastData.moves_dtc   || [];
        const dtm   = _lastData.moves_dtm   || [];
        const dtm50 = _lastData.moves_dtm50 || [];
        const rows  = Math.max(dtz.length, dtc.length, dtm.length, dtm50.length);
        const lines = [];
        if (_lastFen) lines.push(`[FEN "${_lastFen}"]`);
        lines.push('Rank,DTZ Move,DTZ Plies,DTZ Outcome,DTC Move,DTC Plies,DTC Order,DTC Outcome,DTM Move,DTM Plies,DTM Outcome,DTM50 Move,DTM50 Plies,DTM50 Outcome');
        if (_showRootRow) {
            const { dtzEntry, dtcEntry, dtmEntry, dtm50Entry } = _rootEntries(_lastData, _lastFen);
            lines.push([
                '',
                _ROOT_LABEL, _csvPlies(dtzEntry),   dtzEntry.outcome,
                _ROOT_LABEL, _csvPlies(dtcEntry),   dtcEntry.orderText, dtcEntry.outcome,
                _ROOT_LABEL, _csvPlies(dtmEntry),   dtmEntry.outcome,
                _ROOT_LABEL, _csvPlies(dtm50Entry), dtm50Entry.outcome,
            ].map(_csvField).join(','));
        }
        for (let i = 0; i < rows; i++) {
            const d0 = dtz[i],   d2 = dtm[i],   d3 = dtm50[i];
            const d1 = _dtcDisplayEntry(dtc[i] || null, (dtc[i] || {}).child_fen);
            lines.push([
                i + 1,
                d0 ? d0.san : '', d0 ? _csvPlies(d0) : '', d0 ? d0.outcome : '',
                d1 ? d1.san : '', d1 ? _csvPlies(d1) : '', d1 ? d1.orderText : '', d1 ? d1.outcome : '',
                d2 ? d2.san : '', d2 ? _csvPlies(d2) : '', d2 ? d2.outcome : '',
                d3 ? d3.san : '', d3 ? _csvPlies(d3) : '', d3 ? d3.outcome : '',
            ].map(_csvField).join(','));
        }
        const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'chesstb_moves.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ── Public API ────────────────────────────────────────────────────────
    function setMoveSelectHandler(fn)  { _onMoveSelect = fn; }
    function setNoteHandler(fn)        { _onNote = fn; }
    function setResultHandler(fn)      { _onResult = fn; }
    function setViewStateHandler(fn)   { _onViewState = fn; if (fn) fn(_viewState); }
    function getViewState()            { return _viewState; }
    function getLastData()             { return _lastData; }
    function getLastFen()              { return _lastFen; }
    function getLastVariant()          { return _lastVariant; }

    function setShowRootRow(show) {
        _showRootRow = !!show;
        Storage.write(_LS_SHOW_ROOT_ROW, _showRootRow);
        _publish({ showRootRow: _showRootRow, rootRow: _rootRowState(_lastData, _lastFen) });
    }
    function getShowRootRow() { return _showRootRow; }

    function clearErrorLine() { _publish({ error: null }); }

    // Sets the legal-move count text ahead of any probe result - the count
    // is computed client-side from the FEN, not from probe data.
    function setMoveCount(text) { _publish({ moveCount: text }); }

    // ── Table DOM wiring (hover pairing + prefetch + click-to-play) ───────
    // Attached to the rendered <tbody> by the results panel component.
    // Pointer position is tracked so a table rebuild under a stationary
    // pointer (e.g. a probe result arriving mid-hover) can re-evaluate
    // what is underneath it.
    function attachTableEvents(tbody) {
        if (!tbody) return () => {};
        let hoveredPair  = [];
        let lastPointerX = null;
        let lastPointerY = null;
        let lastPointerType = '';

        function pairCells(cell) {
            if (cell.classList.contains('col-move')) {
                const next = cell.nextElementSibling;
                return next && next.dataset.san ? [cell, next] : [cell];
            }
            if (cell.classList.contains('col-score')) {
                const prev = cell.previousElementSibling;
                return prev && prev.dataset.san ? [prev, cell] : [cell];
            }
            return [cell];
        }
        function updatePairHover(target) {
            const cell = target.closest('td[data-san]');
            hoveredPair.forEach(c => c.classList.remove('is-pair-hover'));
            hoveredPair = [];
            if (cell) {
                hoveredPair = pairCells(cell);
                hoveredPair.forEach(c => c.classList.add('is-pair-hover'));
            }
        }
        function updatePrefetch(target) {
            const cell = target.closest('td[data-child-fen]');
            if (!cell || !cell.dataset.childFen) { _cancelPrefetch(); return; }
            const childFen = cell.dataset.childFen;
            const variant = Board.getVariant() || VARIANTS.STANDARD;
            const key = _cacheKey(childFen, variant);
            if (key === _prefetchKey) return;
            _cancelPrefetch();
            if (_prefetchCache.has(key) || _resultCache.has(key)) return;
            _prefetchKey = key;
            const run = {};
            _prefetchRun = run;
            _prefetchTimer = setTimeout(() => {
                const controller = new AbortController();
                _prefetchController = controller;
                _prefetchPromise = fetch('/probe/stream', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Prefetch': '1' },
                    body:    JSON.stringify({ fen: childFen, variant }),
                    signal:  controller.signal,
                })
                .then(async r => {
                    if (!r.ok) {
                        const err = await r.json().catch(() => ({ error: 'Network error.' }));
                        return { ok: false, error: err };
                    }
                    for await (const d of _sseEvents(r)) {
                        if (d.status === 'done') {
                            if (_isComplete(d)) _prefetchCache.set(key, d);
                            return { ok: true, data: d };
                        }
                        if (d.status === 'error') return { ok: false, error: d };
                    }
                    return { ok: false, error: { error: 'Stream ended unexpectedly.' } };
                })
                .catch(err => ({ ok: false, error: err, aborted: err && err.name === 'AbortError' }))
                .finally(() => {
                    if (_prefetchRun === run) {
                        _prefetchController = null; _prefetchKey = null;
                        _prefetchRun = null; _prefetchPromise = null;
                    }
                });
            }, 400);
        }
        function reapplyHoverAtPointer() {
            if (lastPointerX === null) return;
            const el = document.elementFromPoint(lastPointerX, lastPointerY);
            if (!el || !tbody.contains(el)) {
                hoveredPair.forEach(c => c.classList.remove('is-pair-hover'));
                hoveredPair = [];
                return;
            }
            updatePairHover(el);
            updatePrefetch(el);
        }

        function onPointerdown(e) { lastPointerType = e.pointerType; }
        function onClick(e) {
            const type = e.pointerType || lastPointerType;
            lastPointerType = '';
            const dot = e.target.closest('.warning-dot, .info-dot');
            if (dot && (type === 'touch' || type === 'pen')) {
                if (_onNote && dot.title) _onNote(dot.title);
                return;
            }
            const cell = e.target.closest('td[data-san]');
            if (cell && _onMoveSelect) _onMoveSelect(cell.dataset.san);
        }
        function onKeydown(e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const cell = e.target.closest('td[data-san]');
            if (cell && _onMoveSelect) { e.preventDefault(); _onMoveSelect(cell.dataset.san); }
        }
        function onMousemove(e) { lastPointerX = e.clientX; lastPointerY = e.clientY; }
        function onMouseover(e) {
            lastPointerX = e.clientX; lastPointerY = e.clientY;
            updatePairHover(e.target); updatePrefetch(e.target);
        }
        function onMouseleave() {
            lastPointerX = null; lastPointerY = null;
            hoveredPair.forEach(c => c.classList.remove('is-pair-hover'));
            hoveredPair = [];
            _cancelPrefetch();
        }

        tbody.addEventListener('pointerdown', onPointerdown);
        tbody.addEventListener('click', onClick);
        tbody.addEventListener('keydown', onKeydown);
        tbody.addEventListener('mousemove', onMousemove);
        tbody.addEventListener('mouseover', onMouseover);
        tbody.addEventListener('mouseleave', onMouseleave);

        // The pointer may already be sitting over a cell that just
        // (re)appeared without itself moving - re-check on every render.
        reapplyHoverAtPointer();
        _reapplyOnNextRender = reapplyHoverAtPointer;

        return () => {
            tbody.removeEventListener('pointerdown', onPointerdown);
            tbody.removeEventListener('click', onClick);
            tbody.removeEventListener('keydown', onKeydown);
            tbody.removeEventListener('mousemove', onMousemove);
            tbody.removeEventListener('mouseover', onMouseover);
            tbody.removeEventListener('mouseleave', onMouseleave);
            if (_reapplyOnNextRender === reapplyHoverAtPointer) _reapplyOnNextRender = () => {};
        };
    }
    let _reapplyOnNextRender = () => {};
    // Called by the results panel after each render commits, so hover
    // state re-syncs against the freshly-rendered cells.
    function notifyTableRendered() { _reapplyOnNextRender(); }

    return {
        probe, setMoveSelectHandler, setNoteHandler, setResultHandler, getLastData, getLastFen, getLastVariant,
        setShowRootRow, getShowRootRow, clearErrorLine, setMoveCount, exportCsv,
        setViewStateHandler, getViewState, attachTableEvents, notifyTableRendered,
    };

})();

export { Tablebase };
