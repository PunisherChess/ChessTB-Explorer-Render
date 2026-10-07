import { useEffect, useRef } from 'react';
import { formatAutoPlayDelay } from '../hooks/useExplorer.js';
import Button from './ui/Button.jsx';

const SHORTCUTS = [['Enter', 'Apply'], ['F', 'Flip'], ['C', 'Clear'], ['←', 'Back'], ['→', 'Forward']];

const DELAY_MIN = 0;
const DELAY_MAX = 2500;

export default function SettingsPanel({ explorer }) {
    const { settingsOpen, setSettingsOpen, showRootRow, variant, autoplayDelayMs, actions } = explorer;
    const panelRef = useRef(null);
    const chess960 = variant === 'chess960';

    useEffect(() => {
        if (!settingsOpen) return;
        function onDocClick(e) {
            if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest('#settings-btn')) {
                setSettingsOpen(false);
            }
        }
        function onKeydown(e) {
            if (e.key === 'Escape') { e.preventDefault(); setSettingsOpen(false); }
        }
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onKeydown);
        return () => {
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('keydown', onKeydown);
        };
    }, [settingsOpen, setSettingsOpen]);

    const pct = ((autoplayDelayMs - DELAY_MIN) / (DELAY_MAX - DELAY_MIN)) * 100;

    return (
        <div id="settings-panel" ref={panelRef} className={`settings-panel${settingsOpen ? ' is-open' : ''}`}
             role="dialog" aria-modal="false" aria-label="Board settings">
            <div className="settings-panel__header">
                <span className="settings-panel__title">Board Settings</span>
                <Button id="settings-close-btn" compact iconOnly icon="close" aria-label="Close settings"
                        onClick={() => setSettingsOpen(false)} />
            </div>

            <div className="settings-row settings-row--toggle">
                <label className="settings-toggle" htmlFor="show-root-row-toggle">
                    <span className="settings-toggle__label">Show Root Row</span>
                    <span className="toggle-switch">
                        <input type="checkbox" id="show-root-row-toggle" className="toggle-switch__input" role="switch"
                               checked={showRootRow} onChange={(e) => actions.setShowRootRowAction(e.target.checked)} />
                        <span className="toggle-switch__track" aria-hidden="true"></span>
                    </span>
                </label>
            </div>

            <div className="settings-row settings-row--toggle">
                <label className="settings-toggle" htmlFor="chess960-mode-toggle">
                    <span className="settings-toggle__label">Chess960 Mode</span>
                    <span className="toggle-switch">
                        <input type="checkbox" id="chess960-mode-toggle" className="toggle-switch__input" role="switch"
                               checked={chess960} onChange={(e) => actions.setChess960Action(e.target.checked)} />
                        <span className="toggle-switch__track" aria-hidden="true"></span>
                    </span>
                </label>
            </div>

            <div className="settings-row settings-row--slider">
                <span className="settings-slider__label">Autoplay Delay</span>
                <div className="settings-slider__control">
                    <input type="range" id="autoplay-delay-slider" className="range-slider"
                           min={DELAY_MIN} max={DELAY_MAX} step={50} value={autoplayDelayMs}
                           style={{ '--range-fill': `${pct}%` }}
                           aria-label="Autoplay delay" aria-valuetext={formatAutoPlayDelay(autoplayDelayMs)}
                           onChange={(e) => actions.setAutoplayDelayAction(parseInt(e.target.value, 10))} />
                    <div className="range-slider__ticks" aria-hidden="true">
                        <span>0s</span><span>1.25s</span><span>2.5s</span>
                    </div>
                </div>
                <span className="settings-slider__value" id="autoplay-delay-value">{formatAutoPlayDelay(autoplayDelayMs)}</span>
            </div>

            <div className="settings-row settings-row--shortcuts">
                <span className="settings-shortcuts__title">Keyboard Shortcuts</span>
                <ul className="settings-shortcuts__list">
                    {SHORTCUTS.map(([key, action]) => (
                        <li key={key}><kbd>{key}</kbd> {action}</li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
