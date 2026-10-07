import Icon from './ui/Icon.jsx';

function Logo() {
    return (
        <svg className="site-header__logo" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="12" fill="var(--gold)" />
            <g fill="var(--bg)">
                <circle cx="12" cy="8.3" r="2.6" />
                <path d="M10.4 11.2h3.2c.2 2 .9 3.3 2.2 5.4H8.2c1.3-2.1 2-3.4 2.2-5.4z" />
                <rect x="7.2" y="16.6" width="9.6" height="1.9" rx="0.95" />
            </g>
        </svg>
    );
}

export default function Header({ githubUrl, setSettingsOpen }) {
    return (
        <header className="site-header" role="banner">
            <Logo />

            <span className="site-header__title">ChessTB</span>
            <span className="site-header__sep" aria-hidden="true">·</span>
            <span className="site-header__sub">Explorer</span>

            <nav className="site-header__nav" aria-label="Site links">
                {githubUrl && (
                    <a href={githubUrl} className="site-header__link site-header__link--icon"
                       title="GitHub repository" aria-label="GitHub repository" target="_blank" rel="noopener noreferrer">
                        <Icon name="github" />
                    </a>
                )}
                <a href="/admin" className="site-header__link site-header__link--icon"
                   title="Cache dashboard" aria-label="Admin cache dashboard">
                    <Icon name="gauge" />
                </a>
                <a href="/openapi.yaml" className="site-header__link site-header__link--icon"
                   title="API specification" aria-label="API specification" target="_blank" rel="noopener noreferrer">
                    <Icon name="code" />
                </a>
                <button id="settings-btn" className="site-header__link site-header__link--icon"
                        title="Board settings" aria-label="Open board settings"
                        onClick={(e) => { e.stopPropagation(); setSettingsOpen(o => !o); }}>
                    <Icon name="settings" />
                </button>
            </nav>
        </header>
    );
}
