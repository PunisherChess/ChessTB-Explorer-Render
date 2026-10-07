import { useRef } from 'react';

export default function Segmented({ label, options, value, onChange, variant = 'radio', className = '', itemClassName = '' }) {
    const groupRef = useRef(null);
    const tabs = variant === 'tabs';

    function onKeyDown(e) {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        e.stopPropagation();
        const i = options.findIndex(o => o.value === value);
        const next = options[(i + step + options.length) % options.length];
        onChange(next.value);
        groupRef.current?.querySelector(`[data-value="${next.value}"]`)?.focus();
    }

    return (
        <div ref={groupRef} className={className} role={tabs ? 'tablist' : 'radiogroup'} aria-label={label} onKeyDown={onKeyDown}>
            {options.map(o => {
                const active = o.value === value;
                return (
                    <button
                        key={o.value} id={o.id} type="button" data-value={o.value}
                        className={`${itemClassName}${active ? ' is-active' : ''}`}
                        role={tabs ? 'tab' : 'radio'}
                        {...(tabs ? { 'aria-selected': active } : { 'aria-checked': active })}
                        tabIndex={active ? 0 : -1}
                        title={o.title}
                        onClick={() => onChange(o.value)}
                    >
                        {o.content ?? o.label}
                    </button>
                );
            })}
        </div>
    );
}
