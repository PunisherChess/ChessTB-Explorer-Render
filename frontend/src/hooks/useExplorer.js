import { useEffect, useMemo, useRef, useState } from 'react';
import { Board, VARIANTS } from '../engine/board.js';
import { Tablebase } from '../engine/tablebase.js';
import { Theme } from '../engine/theme.js';
import * as Storage from '../engine/storage.js';
import { debounce } from '../engine/utils.js';
import {
    writeHash, readHashFen, readHashVariant, readLastGame, saveGameState, normalizeFen,
} from '../engine/gameState.js';
import { buildPgnText, parsePgn } from '../engine/pgnFormat.js';

const DEFAULT_FEN = '4k3/8/8/8/8/8/8/4K2R w - - 0 1';

const METRIC_CONFIG = {
    dtz:   { dataKey: 'moves_dtz',   label: 'DTZ'   },
    dtc:   { dataKey: 'moves_dtc',   label: 'DTC'   },
    dtm:   { dataKey: 'moves_dtm',   label: 'DTM'   },
    dtm50: { dataKey: 'moves_dtm50', label: 'DTM50' },
};
const AUTO_PLAY_METRICS = Object.keys(METRIC_CONFIG);

const AUTO_PLAY_DELAY_MIN_MS  = 0;
const AUTO_PLAY_DELAY_MAX_MS  = 2500;
const AUTO_PLAY_DELAY_STEP_MS = 50;
const AUTO_PLAY_DELAY_DEFAULT_MS = 1250;
const LS_AUTOPLAY_DELAY_MS = 'chesstb_autoplay_delay_ms';

function clampAutoPlayDelayMs(ms) {
    if (!Number.isFinite(ms)) return AUTO_PLAY_DELAY_DEFAULT_MS;
    const snapped = Math.round(ms / AUTO_PLAY_DELAY_STEP_MS) * AUTO_PLAY_DELAY_STEP_MS;
    return Math.min(AUTO_PLAY_DELAY_MAX_MS, Math.max(AUTO_PLAY_DELAY_MIN_MS, snapped));
}
function readAutoPlayDelayMs() {
    const raw = Storage.read(LS_AUTOPLAY_DELAY_MS);
    const ms = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(ms) ? clampAutoPlayDelayMs(ms) : AUTO_PLAY_DELAY_DEFAULT_MS;
}
export function formatAutoPlayDelay(ms) {
    return ms === 0 ? '0s' : `${parseFloat((ms / 1000).toFixed(2))}s`;
}

let _nextToastId = 1;
const NOTE_MS = 4500;

export function useExplorer() {
    const [ready, setReady]     = useState(false);
    const [fen, setFen]         = useState(DEFAULT_FEN);
    const [variant, setVariant] = useState(VARIANTS.STANDARD);
    const [locked, setLockedState] = useState(false);
    const [canBack, setCanBack] = useState(false);
    const [canForward, setCanForward] = useState(false);
    const [moveHistory, setMoveHistory] = useState({ nodes: [], rootChildren: [], rootActiveChild: null, currentId: -1 });
    const [startFen, setStartFen] = useState(DEFAULT_FEN);
    // The PGN panel stays blank (not even "No moves yet") until Board
    // reports a move-tree change for the first time - a fresh session
    // with nothing restored from a link or localStorage never fires that
    // callback until the player's first action.
    const [historyInitialized, setHistoryInitialized] = useState(false);
    const [fenError, setFenError] = useState(null);

    const [tb, setTb] = useState(() => Tablebase.getViewState());
    const [autoplayMetric, setAutoplayMetric] = useState(null);
    const [autoplayAvailability, setAutoplayAvailability] = useState(
        () => Object.fromEntries(AUTO_PLAY_METRICS.map(m => [m, { disabled: false, title: `Auto-play best ${METRIC_CONFIG[m].label} move` }]))
    );
    const [lockAutoplayDisabled, setLockAutoplayDisabled] = useState(false);

    const [showRootRow, setShowRootRowState] = useState(() => Tablebase.getShowRootRow());
    const [autoplayDelayMs, setAutoplayDelayMsState] = useState(() => readAutoPlayDelayMs());

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [pgnDialogOpen, setPgnDialogOpen] = useState(false);
    const [pgnSnapshots, setPgnSnapshots] = useState([]);
    const [pgnError, setPgnError] = useState('');
    const [toasts, setToasts] = useState([]);
    const [activeMetric, setActiveMetric] = useState('dtz');

    const fenInputRef = useRef(null);
    const tbodyRef    = useRef(null);
    const actionsRef  = useRef({});
    const bootedRef   = useRef(false);

    // ── Toasts ──────────────────────────────────────────────────────────
    function toast(message, durationMs = 1800) {
        const id = _nextToastId++;
        setToasts(prev => [...prev, { id, message, leaving: false }]);
        setTimeout(() => {
            setToasts(prev => prev.map(t => (t.id === id ? { ...t, leaving: true } : t)));
            setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 400);
        }, durationMs);
    }

    const activeNotesRef = useRef(new Set());

    // ── One-time bootstrap ────────────────────────────────────────────────
    useEffect(() => {
        if (bootedRef.current) return;
        bootedRef.current = true;

        const hashFen     = readHashFen();
        const hashVariant = readHashVariant();
        const lastGame    = readLastGame();

        let initialFen, initialVariant, restoreGame;
        if (lastGame && hashFen &&
            normalizeFen(hashFen) === lastGame.currentFen &&
            (hashVariant || VARIANTS.STANDARD) === lastGame.variant) {
            initialFen = normalizeFen(lastGame.startFen);
            initialVariant = lastGame.variant;
            restoreGame = lastGame;
        } else if (hashFen) {
            initialFen = normalizeFen(hashFen);
            initialVariant = hashVariant || VARIANTS.STANDARD;
            restoreGame = null;
        } else if (lastGame) {
            initialFen = normalizeFen(lastGame.startFen);
            initialVariant = lastGame.variant;
            restoreGame = lastGame;
        } else {
            initialFen = DEFAULT_FEN;
            initialVariant = VARIANTS.STANDARD;
            restoreGame = null;
        }

        const debouncedProbe = debounce(Tablebase.probe, 300);

        // ── Auto-play state (refs - pure bookkeeping, no re-render needed) ──
        const autoPlayTimerRef = { current: null };
        const autoPlayCycleIdRef = { current: 0 };
        const autoPlayPacingReadyRef = { current: false };
        const autoPlayDataReadyRef = { current: false };
        const autoPlayMoveInFlightRef = { current: false };
        const autoPlayLockEngagedRef = { current: false };
        const autoPlayMetricRef = { current: null };   // mirrors autoplayMetric state for synchronous checks

        function bestMovesForArrows(data) {
            return {
                dtz:   data?.dtz_available   ? (data.moves_dtz   || [])[0] || null : null,
                dtc:   data?.dtc_available   ? (data.moves_dtc   || [])[0] || null : null,
                dtm:   data?.dtm_available   ? (data.moves_dtm   || [])[0] || null : null,
                dtm50: data?.dtm50_available ? (data.moves_dtm50 || [])[0] || null : null,
            };
        }

        function applySetLocked(next, persist = true) {
            Board.setLocked(next, persist);
            setLockedState(next);
        }

        function stopAutoPlay() {
            const prevMetric = autoPlayMetricRef.current;
            autoPlayMetricRef.current = null;
            setAutoplayMetric(null);
            autoPlayCycleIdRef.current++;
            clearTimeout(autoPlayTimerRef.current);
            autoPlayTimerRef.current = null;
            autoPlayPacingReadyRef.current = false;
            autoPlayDataReadyRef.current = false;
            if (autoPlayLockEngagedRef.current) {
                autoPlayLockEngagedRef.current = false;
                applySetLocked(false, false);
            }
            setLockAutoplayDisabled(false);
            return prevMetric;
        }

        function armAutoPlayWait(dataAlreadyReady) {
            const cycleId = ++autoPlayCycleIdRef.current;
            autoPlayPacingReadyRef.current = false;
            autoPlayDataReadyRef.current = dataAlreadyReady;
            clearTimeout(autoPlayTimerRef.current);
            autoPlayTimerRef.current = setTimeout(() => {
                if (cycleId !== autoPlayCycleIdRef.current) return;
                autoPlayPacingReadyRef.current = true;
                tryPlayAutoPlayMove(cycleId);
            }, actionsRef.current.getAutoplayDelayMs());
        }

        function tryPlayAutoPlayMove(cycleId) {
            if (cycleId !== autoPlayCycleIdRef.current) return;
            if (!autoPlayMetricRef.current) return;
            if (!autoPlayPacingReadyRef.current || !autoPlayDataReadyRef.current) return;

            const metric = autoPlayMetricRef.current;
            const data = Tablebase.getLastData();
            if (!data) return;
            const moves = data[METRIC_CONFIG[metric].dataKey] || [];
            const best = moves.find(m => m.outcome !== 'unknown' && m.available !== false);
            if (!best) { stopAutoPlay(); return; }
            autoPlayMoveInFlightRef.current = true;
            const played = Board.playMove(best.san);
            autoPlayMoveInFlightRef.current = false;
            if (!played) { stopAutoPlay(); return; }
            if (best.is_mate || best.outcome === 'draw') { stopAutoPlay(); return; }
            armAutoPlayWait(false);
        }

        function onAutoPlayResult() {
            if (!autoPlayMetricRef.current) return;
            autoPlayDataReadyRef.current = true;
            tryPlayAutoPlayMove(autoPlayCycleIdRef.current);
        }

        function startAutoPlay(metric) {
            if (!METRIC_CONFIG[metric]) return;
            stopAutoPlay();
            autoPlayMetricRef.current = metric;
            setAutoplayMetric(metric);
            if (!Board.isLocked()) {
                autoPlayLockEngagedRef.current = true;
                applySetLocked(true, false);
            }
            setLockAutoplayDisabled(true);
            const dataAlreadyReady = Tablebase.getLastFen() === Board.currentFen() &&
                                      Tablebase.getLastVariant() === Board.getVariant();
            armAutoPlayWait(dataAlreadyReady);
        }

        function updateAutoplayAvailability(data) {
            const availableByMetric = {
                dtz: data?.dtz_available, dtc: data?.dtc_available,
                dtm: data?.dtm_available, dtm50: data?.dtm50_available,
            };
            const rootWdlByMetric = {
                dtz: data?.wdl,
                dtc: Array.isArray(data?.dtc) ? data.dtc[0] : null,
                dtm: data?.wdl,
                dtm50: Array.isArray(data?.dtm50) ? data.dtm50[0] : null,
            };
            const next = {};
            AUTO_PLAY_METRICS.forEach(metric => {
                const unavailable = availableByMetric[metric] === false;
                const isDraw = !unavailable && rootWdlByMetric[metric] === 0;
                if (unavailable || isDraw) {
                    if (autoPlayMetricRef.current === metric) stopAutoPlay();
                    next[metric] = {
                        disabled: true,
                        title: unavailable
                            ? `Auto-play unavailable — no ${METRIC_CONFIG[metric].label} table for this material`
                            : `${METRIC_CONFIG[metric].label} auto-play unavailable — position is a draw`,
                    };
                } else {
                    next[metric] = { disabled: false, title: `Auto-play best ${METRIC_CONFIG[metric].label} move` };
                }
            });
            setAutoplayAvailability(next);
        }

        // ── Position-change callback ────────────────────────────────────
        function onPositionChange(nextFen, immediate) {
            if (autoPlayMetricRef.current && !autoPlayMoveInFlightRef.current) stopAutoPlay();

            if (fenInputRef.current) {
                fenInputRef.current.value = nextFen;
                fenInputRef.current.classList.remove('is-invalid');
            }
            setFenError(null);
            Tablebase.clearErrorLine();
            setFen(nextFen);
            setVariant(Board.getVariant());
            setCanBack(Board.canGoBack());
            setCanForward(Board.canGoForward());
            writeHash(nextFen, Board.getVariant());
            Board.clearArrows();

            const count = Board.legalMoveCount();
            Tablebase.setMoveCount(count > 0 ? `${count} legal move${count === 1 ? '' : 's'}` : '');

            const onProbeError = () => setReady(true);
            const activeVariant = Board.getVariant();
            if (immediate) {
                debouncedProbe.cancel();
                Tablebase.probe(nextFen, activeVariant, onProbeError);
            } else {
                debouncedProbe(nextFen, activeVariant, onProbeError);
            }
        }

        Board.setOnMoveHistoryChange((history, sFen) => {
            setMoveHistory(history);
            setStartFen(sFen);
            setHistoryInitialized(true);
            setCanBack(Board.canGoBack());
            setCanForward(Board.canGoForward());
            saveGameState(history, sFen, Board.getVariant());
        });

        Tablebase.setResultHandler(data => {
            Board.drawArrows(bestMovesForArrows(data));
            updateAutoplayAvailability(data);
            setReady(true);
            onAutoPlayResult();
        });
        Tablebase.setMoveSelectHandler(san => {
            const played = Board.playMove(san);
            if (!played) toast('Illegal move — this position may have changed.');
        });
        Tablebase.setNoteHandler(message => {
            const active = activeNotesRef.current;
            if (active.has(message)) return;
            active.add(message);
            setTimeout(() => active.delete(message), NOTE_MS + 400);
            toast(message, NOTE_MS);
        });
        Tablebase.setViewStateHandler(setTb);

        // ── Board bootstrap ──────────────────────────────────────────────
        Theme.init(Board.reconstruct);
        setReady(false);
        const boardInit = Board.init(onPositionChange, initialFen, initialVariant);
        if (!boardInit.ok) toast(boardInit.reason || 'Invalid starting position — loaded the default position instead.');
        if (restoreGame) {
            Board.restoreTree(restoreGame.startFen, restoreGame.nodes, restoreGame.rootChildren, restoreGame.rootActiveChild, restoreGame.currentId);
        }
        Theme.apply();

        setVariant(Board.getVariant());
        setLockedState(Board.isLocked());
        setFen(Board.currentFen());
        setStartFen(Board.getStartFen());
        setCanBack(Board.canGoBack());
        setCanForward(Board.canGoForward());
        if (fenInputRef.current) fenInputRef.current.value = Board.currentFen();

        // ── Public actions ───────────────────────────────────────────────
        function applyFen(rawFen) {
            const norm = normalizeFen(rawFen);
            const result = Board.setPosition(norm);
            if (!result.ok) {
                if (fenInputRef.current) fenInputRef.current.classList.add('is-invalid');
                setFenError(result.reason || 'Invalid position.');
                return;
            }
            if (fenInputRef.current) fenInputRef.current.classList.remove('is-invalid');
            setFenError(null);
            Tablebase.clearErrorLine();
        }

        function setTurn(turnChar) {
            const parts = Board.currentFen().split(' ');
            if (parts[1] === turnChar) return;
            parts[1] = turnChar;
            applyFen(parts.join(' '));
        }

        function copyFen() {
            navigator.clipboard.writeText(Board.currentFen())
                .then(() => toast('FEN copied!'))
                .catch(() => {
                    fenInputRef.current?.select();
                    document.execCommand('copy');
                    toast('FEN copied!');
                });
        }

        function copyPgnText() {
            const text = buildPgnText();
            if (!text) { toast('No moves to copy.'); return; }
            navigator.clipboard.writeText(text)
                .then(() => toast('PGN copied!'))
                .catch(() => toast('Could not copy PGN.'));
        }

        function flip() {
            Board.flip();
            Board.drawArrows(bestMovesForArrows(Tablebase.getLastData()));
        }

        function clearBoard() { Board.clear(); }
        function goBack() { Board.goBack(); }
        function goForward() { Board.goForward(); }
        function goToNode(id) { Board.goToNode(id); }

        function setLockedAction(next) {
            if (autoPlayMetricRef.current !== null) return;   // soft-disabled during auto-play
            applySetLocked(next);
        }

        function toggleAutoPlay(metric) {
            if (autoPlayMetricRef.current === metric) stopAutoPlay();
            else startAutoPlay(metric);
        }

        function setShowRootRowAction(next) { Tablebase.setShowRootRow(next); setShowRootRowState(next); }

        function setChess960Action(next) {
            const result = Board.setVariant(next ? VARIANTS.CHESS960 : VARIANTS.STANDARD);
            if (!result.ok) { toast(result.reason || "Can't switch modes for this position.", 3000); return; }
            setVariant(Board.getVariant());
        }

        function setAutoplayDelayAction(ms) {
            const clamped = clampAutoPlayDelayMs(ms);
            Storage.write(LS_AUTOPLAY_DELAY_MS, clamped);
            setAutoplayDelayMsState(clamped);
        }
        function getAutoplayDelayMs() { return actionsRef.current.autoplayDelayMsLive; }

        function openPgnDialog() { setPgnDialogOpen(true); setPgnError(''); }
        function closePgnDialog() { setPgnDialogOpen(false); }
        function parsePgnAction(text) {
            const result = parsePgn(text);
            if (!result.ok) { setPgnError(result.error); return; }
            setPgnError('');
            setPgnSnapshots(result.snapshots);
            actionsRef.current.pgnImportedVariant = result.variant;
        }
        function loadPgnSnapshot(snapFen) {
            const norm = normalizeFen(snapFen);
            const result = Board.setPositionAndVariant(norm, actionsRef.current.pgnImportedVariant || VARIANTS.STANDARD);
            if (!result.ok) { toast(result.reason || 'Could not load that position.'); return; }
            closePgnDialog();
        }

        // Exposed to components via the stable actionsRef object.
        Object.assign(actionsRef.current, {
            applyFen, setTurn, copyFen, copyPgnText, flip, clearBoard, goBack, goForward, goToNode,
            setLockedAction, toggleAutoPlay, setShowRootRowAction, setChess960Action,
            setAutoplayDelayAction, getAutoplayDelayMs, openPgnDialog, closePgnDialog,
            parsePgnAction, loadPgnSnapshot, toast, setActiveMetric,
            exportCsv: Tablebase.exportCsv,
            pgnImportedVariant: VARIANTS.STANDARD,
            autoplayDelayMsLive: readAutoPlayDelayMs(),
        });

        // Very first probe of the session runs immediately (no debounce).
        onPositionChange(Board.currentFen(), true);
    }, []);

    // Keep the ref mirror of autoplayDelayMs current for armAutoPlayWait's
    // synchronous read (it can't see React state directly from inside a
    // closure captured once at bootstrap).
    useEffect(() => {
        actionsRef.current.autoplayDelayMsLive = autoplayDelayMs;
    }, [autoplayDelayMs]);

    // ── Keyboard shortcuts ──────────────────────────────────────────────
    useEffect(() => {
        function onKeydown(e) {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (document.activeElement?.isContentEditable) return;
            if (document.getElementById('promotion-dialog')?.classList.contains('is-visible')) return;
            if (pgnDialogOpen) return;
            if (settingsOpen) return;

            if (e.key === 'ArrowLeft' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); actionsRef.current.goBack(); }
            if (e.key === 'ArrowRight' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); actionsRef.current.goForward(); }
            if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); actionsRef.current.flip(); }
            if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); actionsRef.current.clearBoard(); }
        }
        document.addEventListener('keydown', onKeydown);
        return () => document.removeEventListener('keydown', onKeydown);
    }, [pgnDialogOpen, settingsOpen]);

    // ── hashchange (shared links opened while the tab is open) ───────────
    useEffect(() => {
        function onHashChange() {
            const newFen = readHashFen();
            if (!newFen) return;
            const newVariant = readHashVariant() || VARIANTS.STANDARD;
            const result = Board.setPositionAndVariant(normalizeFen(newFen), newVariant);
            if (!result.ok) {
                actionsRef.current.toast(result.reason || 'Invalid position in URL.');
                writeHash(Board.currentFen(), Board.getVariant());
            }
        }
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    const actions = useMemo(() => new Proxy({}, {
        get: (_t, prop) => (...args) => actionsRef.current[prop]?.(...args),
    }), []);

    return {
        ready, fen, variant, locked, canBack, canForward, moveHistory, startFen, historyInitialized, fenError,
        tb, autoplayMetric, autoplayAvailability, lockAutoplayDisabled,
        showRootRow, autoplayDelayMs, settingsOpen, setSettingsOpen,
        pgnDialogOpen, pgnSnapshots, pgnError, toasts, activeMetric,
        fenInputRef, tbodyRef, actions,
    };
}
