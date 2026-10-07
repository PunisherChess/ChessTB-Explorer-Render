// Scrolls `el` into view within `container` only - never any ancestor
// beyond it (unlike Element.scrollIntoView(), which would also drag the
// mobile screen-carousel over to whichever panel is calling this).
export function scrollIntoViewWithin(el, container) {
    if (!el || !container) return;
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (elRect.top < containerRect.top) {
        container.scrollTop -= (containerRect.top - elRect.top);
    } else if (elRect.bottom > containerRect.bottom) {
        container.scrollTop += (elRect.bottom - containerRect.bottom);
    }
    if (elRect.left < containerRect.left) {
        container.scrollLeft -= (containerRect.left - elRect.left);
    } else if (elRect.right > containerRect.right) {
        container.scrollLeft += (elRect.right - containerRect.right);
    }
}

// While .moves-body-scroll overflows vertically, its scrollbar narrows the
// content box. The body table is widened by the scrollbar's measured width
// so its columns keep the same pixel widths as the header table's.
export function syncMovesGutter() {
    const scroller = document.querySelector('.moves-body-scroll');
    if (!scroller) return;
    if (scroller.scrollHeight <= scroller.clientHeight + 1) {
        scroller.classList.remove('has-vscroll');
        scroller.style.removeProperty('--moves-vscroll-width');
        return;
    }
    const scrollbarWidth = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
    scroller.style.setProperty('--moves-vscroll-width', `${scrollbarWidth}px`);
    scroller.classList.add('has-vscroll');
}

export function initMovesGutterSync() {
    const scroller = document.querySelector('.moves-body-scroll');
    const tbody = document.getElementById('moves-tbody');
    if (!scroller || !tbody) return () => {};
    syncMovesGutter();
    const observer = new ResizeObserver(syncMovesGutter);
    observer.observe(scroller);
    observer.observe(tbody);
    window.addEventListener('resize', syncMovesGutter, { passive: true });
    return () => {
        observer.disconnect();
        window.removeEventListener('resize', syncMovesGutter);
    };
}
