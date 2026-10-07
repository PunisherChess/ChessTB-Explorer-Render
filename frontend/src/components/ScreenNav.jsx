import { useEffect, useState } from 'react';

const SCREENS = ['Board', 'Results', 'Moves'];

export default function ScreenNav() {
    const [current, setCurrent] = useState(0);

    useEffect(() => {
        const content = document.querySelector('.content');
        if (!content) return undefined;
        const onScroll = () => setCurrent(Math.round(content.scrollLeft / content.clientWidth));
        content.addEventListener('scroll', onScroll, { passive: true });
        return () => content.removeEventListener('scroll', onScroll);
    }, []);

    function goTo(index) {
        const content = document.querySelector('.content');
        if (!content) return;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        content.scrollTo({ left: index * content.clientWidth, behavior: reduced ? 'auto' : 'smooth' });
    }

    return (
        <nav className="screen-nav" aria-label="Screens">
            {SCREENS.map((label, i) => (
                <button key={label} type="button" className="screen-nav__item"
                        aria-current={i === current ? 'page' : undefined} onClick={() => goTo(i)}>
                    {label}
                </button>
            ))}
        </nav>
    );
}
