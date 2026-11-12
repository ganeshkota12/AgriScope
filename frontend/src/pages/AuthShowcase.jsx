import { Link } from 'react-router-dom'

/* Shared by the Login and Register pages: the brand, the icons and the
   green panel on the left. */

export function Icon({ name, size = 20 }) {
    const props = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
    }

    switch (name) {
        case 'leaf':
            return (
                <svg {...props}>
                    <path d="M4 20c0-9 6-15 16-16 1 10-5 16-14 16" />
                    <path d="M4 20c3-5 7-8 12-10" />
                </svg>
            )
        case 'trend':
            return (
                <svg {...props}>
                    <path d="m3 17 6-6 4 4 8-8" />
                    <path d="M15 7h6v6" />
                </svg>
            )
        case 'compare':
            return (
                <svg {...props}>
                    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
                </svg>
            )
        case 'sparkle':
            return (
                <svg {...props}>
                    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
                    <path d="m12 7 1.8 3.2L17 12l-3.2 1.8L12 17l-1.8-3.2L7 12z" />
                </svg>
            )
        case 'arrow':
            return (
                <svg {...props}>
                    <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
            )
        default:
            return null
    }
}

// The browser's own wording for "could not reach the server" means nothing to a
// reader, so it becomes a plain sentence. Messages from the server pass through.
export function plainError(error, fallback) {
    const text = String(error?.message ?? '')
    if (error instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed/i.test(text)) {
        return 'We could not reach the server. Please check your connection and try again.'
    }
    return text || fallback
}

export function Brand({ mobile = false }) {
    return (
        <Link to="/login" className={`auth-brand${mobile ? ' mobile-brand' : ''}`}>
            <span className="brand-mark" aria-hidden="true">
                <Icon name="leaf" size={22} />
            </span>
            <span>AgriScope</span>
        </Link>
    )
}

// Only things the app can do today.
const FEATURES = [
    { icon: 'trend', title: 'Yield estimates', text: 'See estimated yields for past seasons' },
    { icon: 'compare', title: 'District comparison', text: 'Compare two districts side by side' },
    { icon: 'sparkle', title: 'AI farming assistant', text: 'Ask questions in plain language' },
]

export default function AuthShowcase({ label, title, accent, description }) {
    return (
        <aside className="auth-showcase">
            <Brand />

            <div className="showcase-copy">
                <span className="showcase-label">{label}</span>

                <h1>
                    {title}
                    <span>{accent}</span>
                </h1>

                <p className="showcase-description">{description}</p>

                <ul className="showcase-features">
                    {FEATURES.map((feature) => (
                        <li className="showcase-feature" key={feature.title}>
                            <span className="feature-icon" aria-hidden="true">
                                <Icon name={feature.icon} size={19} />
                            </span>
                            <div>
                                <strong>{feature.title}</strong>
                                <span>{feature.text}</span>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="showcase-footer">
                <span className="footer-dot" />
                Data-driven insights for agriculture
            </div>
        </aside>
    )
}