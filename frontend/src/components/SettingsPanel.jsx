/** SettingsPanel.jsx: board settings panel */

import { memo, useEffect, useRef } from 'react';
import { VARIANTS, ALIGN, AUTOPLAY_DELAY, formatAutoPlayDelay } from '../engine/constants.js';
import Button from './ui/Button.jsx';

const SHORTCUTS = [['Enter', 'Apply'], ['F', 'Flip'], ['C', 'Clear'], ['←', 'Back'], ['→', 'Forward']];

const { MIN_MS: DELAY_MIN, MAX_MS: DELAY_MAX, STEP_MS: DELAY_STEP } = AUTOPLAY_DELAY;
const DELAY_TICKS = [DELAY_MIN, DELAY_MAX / 2, DELAY_MAX];

// Two-way switch: off selects the left option, on selects the right one.
function ChoiceToggle({ id, title, label, left, right, checked, onChange, className = '' }) {
    return (
        <div className={`settings-row settings-row--toggle ${className}`}>
            <div className="settings-choice-row">
                <span className="settings-toggle__label">{title}</span>
                <span className={`settings-choice__option settings-choice__option--left${checked ? '' : ' is-active'}`}
                      aria-hidden="true" onClick={() => onChange(false)}>{left}</span>
                <span className="toggle-switch toggle-switch--choice">
                    <input type="checkbox" id={id} className="toggle-switch__input" role="switch" aria-label={label}
                           checked={checked} onChange={(e) => onChange(e.target.checked)} />
                    <span className="toggle-switch__track" aria-hidden="true"></span>
                </span>
                <span className={`settings-choice__option settings-choice__option--right${checked ? ' is-active' : ''}`}
                      aria-hidden="true" onClick={() => onChange(true)}>{right}</span>
            </div>
        </div>
    );
}

function SettingsPanel({ open, setOpen, showRootRow, variant, autoplayDelayMs, align, actions }) {
    const panelRef = useRef(null);
    const chess960 = variant === VARIANTS.CHESS960;

    useEffect(() => {
        if (!open) return;
        // Clicks on the header's settings button are skipped here: the
        // button toggles the panel itself.
        function onDocClick(e) {
            if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest('#settings-btn')) {
                setOpen(false);
            }
        }
        function onKeydown(e) {
            if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
        }
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onKeydown);
        return () => {
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('keydown', onKeydown);
        };
    }, [open, setOpen]);

    const pct = ((autoplayDelayMs - DELAY_MIN) / (DELAY_MAX - DELAY_MIN)) * 100;

    return (
        <div id="settings-panel" ref={panelRef} className={`settings-panel${open ? ' is-open' : ''}`}
             role="dialog" aria-modal="false" aria-label="Board settings">
            <div className="settings-panel__header">
                <span className="settings-panel__title">Board Settings</span>
                <Button id="settings-close-btn" compact iconOnly icon="close" aria-label="Close settings"
                        onClick={() => setOpen(false)} />
            </div>

            <ChoiceToggle id="show-root-row-toggle" title="Root Score" label="Show root score" left="Hide" right="Show"
                          checked={showRootRow} onChange={(on) => actions.setShowRootRowAction(on)} />

            <ChoiceToggle id="chess960-mode-toggle" title="Variant" label="Chess960 variant" left="Standard" right="Chess960"
                          checked={chess960} onChange={(on) => actions.setChess960Action(on)} />

            <ChoiceToggle id="align-top-toggle" title="Alignment" label="Align to top" left="Center" right="Top"
                          className="settings-row--align" checked={align === ALIGN.TOP}
                          onChange={(on) => actions.setAlignAction(on ? ALIGN.TOP : ALIGN.CENTER)} />

            <div className="settings-row settings-row--slider">
                <span className="settings-slider__label">Autoplay Delay</span>
                <div className="settings-slider__control">
                    <input type="range" id="autoplay-delay-slider" className="range-slider"
                           min={DELAY_MIN} max={DELAY_MAX} step={DELAY_STEP} value={autoplayDelayMs}
                           style={{ '--range-fill': `${pct}%` }}
                           aria-label="Autoplay delay" aria-valuetext={formatAutoPlayDelay(autoplayDelayMs)}
                           onChange={(e) => actions.setAutoplayDelayAction(parseInt(e.target.value, 10))} />
                    <div className="range-slider__ticks" aria-hidden="true">
                        {DELAY_TICKS.map(ms => <span key={ms}>{formatAutoPlayDelay(ms)}</span>)}
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

export default memo(SettingsPanel);
