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

export default function App({ githubUrl }) {
    const explorer = useExplorer();

    return (
        <>
            <Header githubUrl={githubUrl} setSettingsOpen={explorer.setSettingsOpen} />

            <main className="content" role="main">
                <div className="left-col">
                    <FenBar explorer={explorer} />
                    <BoardArea explorer={explorer} />
                </div>

                <div className="right-col">
                    <ResultsPanel explorer={explorer} />
                </div>

                <div className="pgn-col">
                    <PgnPanel explorer={explorer} />
                </div>
            </main>

            <ScreenNav />

            <PromotionDialog />
            <PgnDialog explorer={explorer} />
            <SettingsPanel explorer={explorer} />
            <Toasts toasts={explorer.toasts} />
        </>
    );
}
