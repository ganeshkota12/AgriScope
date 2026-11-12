import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'

// If something unexpected breaks while the app is running, show a calm page
// instead of a blank screen.
class ErrorBoundary extends Component {
    state = { failed: false }

    static getDerivedStateFromError() {
        return { failed: true }
    }

    componentDidCatch(error) {
        console.error('AgriScope hit an unexpected error:', error)
    }

    render() {
        if (!this.state.failed) return this.props.children

        return (
            <div
                role="alert"
                style={{
                    minHeight: '100vh',
                    display: 'grid',
                    placeItems: 'center',
                    padding: 24,
                    textAlign: 'center',
                    color: '#182218',
                }}
            >
                <div style={{ maxWidth: 420 }}>
                    <h1 style={{ margin: '0 0 10px', fontSize: 26 }}>Something went wrong</h1>
                    <p style={{ margin: '0 0 20px', color: '#5f6e62', lineHeight: 1.7 }}>
                        Please reload the page. If it keeps happening, log out and sign in again.
                    </p>
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        style={{
                            minHeight: 44,
                            padding: '0 22px',
                            border: 0,
                            borderRadius: 11,
                            background: '#1f4d32',
                            color: '#fff',
                            fontWeight: 700,
                            cursor: 'pointer',
                        }}
                    >
                        Reload the page
                    </button>
                </div>
            </div>
        )
    }
}

createRoot(document.getElementById('root')).render(
    <StrictMode>
        <ErrorBoundary>
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </ErrorBoundary>
    </StrictMode>,
)