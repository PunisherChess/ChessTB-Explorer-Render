import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

export default function FenBar({ explorer }) {
    const { fenInputRef, actions, ready, fen, locked, lockAutoplayDisabled, canBack, canForward, fenError, tb } = explorer;
    const errorMessage = fenError ?? tb.error?.message ?? '';
    const isCoverageError = !fenError && !!tb.error?.isCoverage;

    function onFenKeyDown(e) {
        if (e.key === 'Enter') { e.preventDefault(); actions.applyFen(e.currentTarget.value.trim()); }
    }
    function onApplyClick() {
        const v = fenInputRef.current?.value.trim();
        if (v) actions.applyFen(v);
    }
    function onLockClick(e) {
        if (e.currentTarget.getAttribute('aria-disabled') === 'true') return;
        actions.setLockedAction(!locked);
    }

    return (
        <>
            <div className="fen-block">
                <div className="fen-input-wrap">
                    <span className="fen-input-wrap__label" aria-hidden="true">FEN</span>
                    <input
                        id="fen-input" className="fen-input" type="text"
                        ref={fenInputRef} defaultValue={fen}
                        placeholder="Paste FEN here…" disabled={!ready}
                        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck="false"
                        aria-label="FEN position string"
                        onKeyDown={onFenKeyDown}
                    />
                    <button id="lock-btn" type="button"
                            className={`btn btn--icon-only btn--lock${locked ? ' is-locked' : ''}${lockAutoplayDisabled ? ' is-autoplay-disabled' : ''}`}
                            aria-pressed={locked} aria-disabled={lockAutoplayDisabled}
                            aria-label="Lock board to legal moves only"
                            title={lockAutoplayDisabled ? 'Stop auto-play to change Lock' : (locked ? 'Unlock board' : 'Lock board (legal moves only)')}
                            onClick={onLockClick}>
                        <Icon name="lockOpen" className="btn__icon lock-icon lock-icon--unlocked" />
                        <Icon name="lockClosed" className="btn__icon lock-icon lock-icon--locked" />
                    </button>
                </div>

                <div className="fen-actions" role="toolbar" aria-label="Board actions">
                    <Button id="apply-btn" variant="primary" grow icon="check" title="Apply FEN (Enter)" disabled={!ready} onClick={onApplyClick}>Apply</Button>
                    <Button id="flip-btn" grow icon="flip" title="Flip board (F)" onClick={() => actions.flip()}>Flip</Button>
                    <Button id="clear-btn" grow icon="trash" title="Clear board (C)" onClick={() => actions.clearBoard()}>Clear</Button>
                    <Button id="copy-btn" grow icon="copy" title="Copy FEN to clipboard" aria-label="Copy FEN to clipboard" onClick={() => actions.copyFen()}>Copy</Button>
                    <Button id="back-btn" iconOnly icon="arrowLeft" title="Undo (←)" aria-label="Undo" disabled={!canBack} onClick={() => actions.goBack()} />
                    <Button id="forward-btn" iconOnly icon="arrowRight" title="Redo (→)" aria-label="Redo" disabled={!canForward} onClick={() => actions.goForward()} />
                </div>
            </div>

            <div id="error-line" className={`error-line${isCoverageError ? ' is-coverage-error' : ''}`} role="alert" aria-live="polite">
                {errorMessage}
            </div>
        </>
    );
}
