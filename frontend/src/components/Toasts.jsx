export default function Toasts({ toasts }) {
    return (
        <div id="toast-container" className="toast-container" aria-live="polite" aria-atomic="false">
            {toasts.map(t => (
                <div key={t.id} className={`toast${t.leaving ? ' is-out' : ''}`}>{t.message}</div>
            ))}
        </div>
    );
}
