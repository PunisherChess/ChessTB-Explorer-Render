/** useExplorer.js: explorer state, FEN box, PGN, auto-play, settings, and keyboard shortcuts */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from '../engine/board.js';
import { Tablebase } from '../engine/tablebase.js';
import { Theme } from '../engine/theme.js';
import { VARIANTS, METRICS, STORAGE_KEYS, AUTOPLAY_DELAY, CLEARED_FEN } from '../engine/constants.js';
import * as Storage from '../engine/storage.js';
import { debounce } from '../engine/utils.js';
import {
    writeHash, readHashFen, readHashVariant, readLastGame, saveGameState, normalizeFen,
} from '../engine/gameState.js';
import { buildPgnText, parsePgn } from '../engine/pgnFormat.js';

const DEFAULT_FEN = '4k3/8/8/8/8/8/8/4K2R w - - 0 1';

// The startup and cleared positions are shown as an empty box, for either side
// to move, so that a pasted FEN replaces them directly.
function fenInputText(fen) {
    const parts = fen.split(' ');
    parts[1] = 'w';
    const key = parts.join(' ');
    return key === DEFAULT_FEN || key === CLEARED_FEN ? '' : fen;
}

const AUTO_PLAY_METRICS = Object.keys(METRICS);

function clampAutoPlayDelayMs(ms) {
    if (!Number.isFinite(ms)) return AUTOPLAY_DELAY.DEFAULT_MS;
    const snapped = Math.round(ms / AUTOPLAY_DELAY.STEP_MS) * AUTOPLAY_DELAY.STEP_MS;
    return Math.min(AUTOPLAY_DELAY.MAX_MS, Math.max(AUTOPLAY_DELAY.MIN_MS, snapped));
}
function readAutoPlayDelayMs() {
    const raw = Storage.read(STORAGE_KEYS.AUTOPLAY_DELAY_MS);
    const ms = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(ms) ? clampAutoPlayDelayMs(ms) : AUTOPLAY_DELAY.DEFAULT_MS;
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
    // The PGN panel stays blank until the bootstrap effect has loaded the
    // board and any restored game, so "No moves yet" never precedes restored moves.
    const [historyInitialized, setHistoryInitialized] = useState(false);
    const [fenError, setFenError] = useState(null);

    const [tb, setTb] = useState(Tablebase.getViewState);
    const [autoplayMetric, setAutoplayMetric] = useState(null);
    const [autoplayAvailability, setAutoplayAvailability] = useState(
        () => Object.fromEntries(AUTO_PLAY_METRICS.map(m => [m, { disabled: false, title: `Auto-play best ${METRICS[m].label} move` }]))
    );
    const [lockAutoplayDisabled, setLockAutoplayDisabled] = useState(false);

    const [showRootRow, setShowRootRowState] = useState(Tablebase.getShowRootRow);
    const [autoplayDelayMs, setAutoplayDelayMsState] = useState(readAutoPlayDelayMs);

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [pgnDialogOpen, setPgnDialogOpen] = useState(false);
    const [pgnError, setPgnError] = useState('');
    const [toasts, setToasts] = useState([]);
    const [activeMetric, setActiveMetric] = useState('dtz');

    const fenInputRef = useRef(null);
    const actionsRef  = useRef({});
    const bootedRef   = useRef(false);
    // Mirrors autoplayDelayMs for the bootstrap closure.
    const autoplayDelayRef = useRef(autoplayDelayMs);
    useEffect(() => { autoplayDelayRef.current = autoplayDelayMs; }, [autoplayDelayMs]);

    // ── Toasts ──────────────────────────────────────────────────────────
    const toast = useCallback((message, durationMs = 1800) => {
        const id = _nextToastId++;
        setToasts(prev => [...prev, { id, message, leaving: false }]);
        setTimeout(() => {
            setToasts(prev => prev.map(t => (t.id === id ? { ...t, leaving: true } : t)));
            setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 400);
        }, durationMs);
    }, []);

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
            return Object.fromEntries(Object.entries(METRICS).map(([id, m]) => [
                id, data?.[m.availableKey] ? (data[m.dataKey] || [])[0] || null : null,
            ]));
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
            autoPlayTimerRef.current = null;
            if (!dataAlreadyReady) return;
            autoPlayTimerRef.current = setTimeout(() => {
                if (cycleId !== autoPlayCycleIdRef.current) return;
                autoPlayPacingReadyRef.current = true;
                tryPlayAutoPlayMove(cycleId);
            }, autoplayDelayRef.current);
        }

        function tryPlayAutoPlayMove(cycleId) {
            if (cycleId !== autoPlayCycleIdRef.current) return;
            if (!autoPlayMetricRef.current) return;
            if (!autoPlayPacingReadyRef.current || !autoPlayDataReadyRef.current) return;

            const metric = autoPlayMetricRef.current;
            const data = Tablebase.getLastData();
            if (!data) return;
            const moves = data[METRICS[metric].dataKey] || [];
            const best = moves.find(m => m.outcome !== 'unknown' && m.available !== false);
            if (!best) { stopAutoPlay(); return; }
            autoPlayMoveInFlightRef.current = true;
            const played = Board.playMove(best.san);
            autoPlayMoveInFlightRef.current = false;
            if (!played) { stopAutoPlay(); return; }
            if (best.is_mate || best.outcome === 'draw') { stopAutoPlay(); return; }
            armAutoPlayWait(false);
        }

        function resultsMatchBoard() {
            return Tablebase.getLastFen() === Board.currentFen() &&
                   Tablebase.getLastVariant() === Board.getVariant();
        }

        function onAutoPlayResult() {
            if (!autoPlayMetricRef.current || autoPlayDataReadyRef.current) return;
            if (!resultsMatchBoard()) return;
            armAutoPlayWait(true);
        }

        function startAutoPlay(metric) {
            if (!METRICS[metric]) return;
            stopAutoPlay();
            autoPlayMetricRef.current = metric;
            setAutoplayMetric(metric);
            if (!Board.isLocked()) {
                autoPlayLockEngagedRef.current = true;
                applySetLocked(true, false);
            }
            setLockAutoplayDisabled(true);
            armAutoPlayWait(resultsMatchBoard());
        }

        function updateAutoplayAvailability(data) {
            const rootWdlByMetric = {
                dtz: data?.wdl,
                dtc: Array.isArray(data?.dtc) ? data.dtc[0] : null,
                dtm: data?.wdl,
                dtm50: Array.isArray(data?.dtm50) ? data.dtm50[0] : null,
            };
            const next = {};
            AUTO_PLAY_METRICS.forEach(metric => {
                const unavailable = data?.[METRICS[metric].availableKey] === false;
                const isDraw = !unavailable && rootWdlByMetric[metric] === 0;
                if (unavailable || isDraw) {
                    if (autoPlayMetricRef.current === metric) stopAutoPlay();
                    next[metric] = {
                        disabled: true,
                        title: unavailable
                            ? `Auto-play unavailable — no ${METRICS[metric].label} table for this material`
                            : `${METRICS[metric].label} auto-play unavailable — position is a draw`,
                    };
                } else {
                    next[metric] = { disabled: false, title: `Auto-play best ${METRICS[metric].label} move` };
                }
            });
            setAutoplayAvailability(next);
        }

        // ── Position-change callback ────────────────────────────────────
        function onPositionChange(nextFen, immediate) {
            if (autoPlayMetricRef.current && !autoPlayMoveInFlightRef.current) stopAutoPlay();

            if (fenInputRef.current) {
                fenInputRef.current.value = fenInputText(nextFen);
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

            const count = Board.isInsufficientMaterial() ? 0 : Board.legalMoveCount();
            Tablebase.setMoveCount(count > 0 ? `${count} legal move${count === 1 ? '' : 's'}` : '');

            const onProbeError = () => setReady(true);
            const activeVariant = Board.getVariant();
            if (immediate) {
                debouncedProbe.cancel();
                Tablebase.probe(nextFen, activeVariant, onProbeError);
            } else {
                Tablebase.markPending();
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

        // fen, variant, undo/redo state and the FEN box are set by the
        // onPositionChange call at the end of this effect.
        setLockedState(Board.isLocked());
        setStartFen(Board.getStartFen());
        setMoveHistory(Board.getMoveHistory());
        setHistoryInitialized(true);

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
                    const input = fenInputRef.current;
                    if (input) {
                        const shown = input.value;
                        input.value = Board.currentFen();
                        input.select();
                        document.execCommand('copy');
                        input.value = shown;
                    }
                    toast('FEN copied!');
                });
        }

        function exportPgn() {
            const text = buildPgnText();
            if (!text) { toast('No moves to export.'); return; }
            const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/x-chess-pgn;charset=utf-8' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'chesstb_game.pgn';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
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
            Storage.write(STORAGE_KEYS.AUTOPLAY_DELAY_MS, clamped);
            setAutoplayDelayMsState(clamped);
        }

        function openPgnDialog() { setPgnDialogOpen(true); setPgnError(''); }
        function closePgnDialog() { setPgnDialogOpen(false); }
        function parsePgnAction(text) {
            const result = parsePgn(text);
            if (!result.ok) { setPgnError(result.error); return; }
            const loaded = Board.importGame(result.tree, result.variant);
            if (!loaded.ok) { setPgnError(loaded.reason); return; }
            setPgnError('');
            closePgnDialog();
        }

        // Exposed to components via the stable actionsRef object.
        Object.assign(actionsRef.current, {
            applyFen, setTurn, copyFen, exportPgn, flip, clearBoard, goBack, goForward, goToNode,
            setLockedAction, toggleAutoPlay, setShowRootRowAction, setChess960Action,
            setAutoplayDelayAction, onAutoPlayResult, openPgnDialog, closePgnDialog,
            parsePgnAction,
            exportCsv: Tablebase.exportCsv,
        });

        // First probe of the session runs immediately (no debounce).
        onPositionChange(Board.currentFen(), true);
    }, [toast]);

    // Auto-play starts its delay once the position's results have rendered.
    // Two frames also let a zero-delay run show each position's results.
    useEffect(() => {
        if (!autoplayMetric || tb.pending || tb.loading) return;
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => actionsRef.current.onAutoPlayResult());
        });
        return () => cancelAnimationFrame(frame);
    }, [tb, autoplayMetric]);

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
                toast(result.reason || 'Invalid position in URL.');
                writeHash(Board.currentFen(), Board.getVariant());
            }
        }
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, [toast]);

    // Referentially stable: each property is a forwarding function to
    // actionsRef, which bootstrap fills in.
    const actions = useMemo(() => new Proxy({}, {
        get(target, prop) {
            if (typeof prop !== 'string') return undefined;
            return (target[prop] ??= (...args) => actionsRef.current[prop]?.(...args));
        },
    }), []);

    return {
        ready, fen, variant, locked, canBack, canForward, moveHistory, startFen, historyInitialized, fenError,
        tb, autoplayMetric, autoplayAvailability, lockAutoplayDisabled,
        showRootRow, autoplayDelayMs, settingsOpen, setSettingsOpen,
        pgnDialogOpen, pgnError, toasts, activeMetric,
        fenInputRef, actions, setActiveMetric,
    };
}
