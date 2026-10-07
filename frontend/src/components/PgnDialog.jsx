import { useEffect, useRef } from 'react';
import Button from './ui/Button.jsx';

export default function PgnDialog({ explorer }) {
    const { pgnDialogOpen, pgnSnapshots, pgnError, actions } = explorer;
    const textareaRef = useRef(null);

    useEffect(() => {
        if (pgnDialogOpen) textareaRef.current?.focus();
    }, [pgnDialogOpen]);

    useEffect(() => {
        if (!pgnDialogOpen) return;
        function onKeydown(e) {
            if (e.key === 'Escape') { e.preventDefault(); actions.closePgnDialog(); }
        }
        document.addEventListener('keydown', onKeydown);
        return () => document.removeEventListener('keydown', onKeydown);
    }, [pgnDialogOpen, actions]);

    function onBackdropClick(e) {
        if (e.target.id === 'pgn-dialog') actions.closePgnDialog();
    }
    function onParseClick() {
        actions.parsePgnAction(textareaRef.current?.value || '');
    }

    return (
        <div id="pgn-dialog" className={`pgn-dialog${pgnDialogOpen ? ' is-open' : ''}`}
             role="dialog" aria-modal="true" aria-label="Import PGN" onClick={onBackdropClick}>
            <div className="pgn-dialog__inner">
                <div className="pgn-dialog__header">
                    <h2 className="pgn-dialog__title">Import PGN</h2>
                    <button id="pgn-close-btn" className="pgn-dialog__close" aria-label="Close" onClick={() => actions.closePgnDialog()}>✕</button>
                </div>
                <textarea id="pgn-input" className="pgn-dialog__textarea" ref={textareaRef}
                          placeholder="Paste PGN here… e.g.  1. e4 e5 2. Nf3 Nc6 3. Bc4"
                          rows={7} spellCheck="false" />
                <div id="pgn-error" className="pgn-dialog__error" role="alert" aria-live="polite">{pgnError}</div>
                <Button id="pgn-parse-btn" onClick={onParseClick}>Parse Game</Button>
                <div id="pgn-moves" className="pgn-dialog__moves" role="list" aria-label="Game moves">
                    {pgnSnapshots.map((snap, i) => (
                        <button key={i} className="pgn-move-btn" onClick={() => actions.loadPgnSnapshot(snap.fen)}>
                            {snap.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
