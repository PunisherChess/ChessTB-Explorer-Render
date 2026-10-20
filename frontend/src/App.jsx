import { useExplorer } from './hooks/useExplorer.js';
import Header from './components/Header.jsx';
import FenBar from './components/FenBar.jsx';
import BoardArea from './components/BoardArea.jsx';
import ResultsPanel from './components/ResultsPanel.jsx';
import PgnPanel from './components/PgnPanel.jsx';
import PgnDialog from './components/PgnDialog.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import Toasts from './components/Toasts.jsx';
import PromotionDialog from './components/PromotionDialog.jsx';
import ScreenNav from './components/ScreenNav.jsx';

// Children are memoised and receive only the values they render.
// `actions`, `setSettingsOpen`, `setActiveMetric` and `fenInputRef` must stay
// referentially stable.
export default function App({ githubUrl }) {
    const {
        ready, fen, variant, locked, canBack, canForward, moveHistory, startFen, historyInitialized,
        fenError, tb, autoplayMetric, autoplayAvailability, lockAutoplayDisabled, showRootRow,
        autoplayDelayMs, settingsOpen, setSettingsOpen, pgnDialogOpen, pgnError,
        toasts, activeMetric, setActiveMetric, fenInputRef, actions,
    } = useExplorer();
    const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w';

    return (
        <>
            <Header githubUrl={githubUrl} setSettingsOpen={setSettingsOpen} />

            <main className="content" role="main">
                <div className="left-col">
                    <FenBar
                        fenInputRef={fenInputRef} actions={actions} ready={ready} locked={locked}
                        lockAutoplayDisabled={lockAutoplayDisabled} canBack={canBack} canForward={canForward}
                        fenError={fenError} tbError={tb.error}
                    />
                    <BoardArea turn={turn} onTurnChange={actions.setTurn} />
                </div>

                <div className="right-col">
                    <ResultsPanel
                        tb={tb} activeMetric={activeMetric} setActiveMetric={setActiveMetric}
                        autoplayMetric={autoplayMetric} autoplayAvailability={autoplayAvailability} actions={actions}
                    />
                </div>

                <div className="pgn-col">
                    <PgnPanel
                        moveHistory={moveHistory} startFen={startFen}
                        historyInitialized={historyInitialized} actions={actions}
                    />
                </div>
            </main>

            <ScreenNav />

            <PromotionDialog />
            <PgnDialog open={pgnDialogOpen} error={pgnError} actions={actions} />
            <SettingsPanel
                open={settingsOpen} setOpen={setSettingsOpen} showRootRow={showRootRow}
                variant={variant} autoplayDelayMs={autoplayDelayMs} actions={actions}
            />
            <Toasts toasts={toasts} />
        </>
    );
}
