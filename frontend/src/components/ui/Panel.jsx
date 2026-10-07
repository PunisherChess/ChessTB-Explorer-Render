export default function Panel({ label, title, start, end, className = '', children }) {
    return (
        <section className={`panel${className ? ` ${className}` : ''}`} aria-label={label}>
            <div className="panel-header">
                <div className="panel-header__start">
                    <span className="panel-header__title">{title}</span>
                    {start}
                </div>
                <div className="panel-header__end">{end}</div>
            </div>
            {children}
        </section>
    );
}
