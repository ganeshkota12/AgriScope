import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { loginUser } from '../services/api'
import AuthShowcase, { Brand, Icon, plainError } from './AuthShowcase'
import './Register.css'

export default function Login() {
    const navigate = useNavigate()
    const location = useLocation()

    // After creating an account the person lands here with their email filled in.
    const [email, setEmail] = useState(location.state?.email ?? '')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [notice, setNotice] = useState(
        location.state?.registered
            ? { type: 'success', text: 'Your account is ready. Sign in to continue.' }
            : location.state?.expired
                ? { type: 'info', text: 'Your session has ended. Please sign in again.' }
                : null
    )

    useEffect(() => {
        document.title = 'Sign in \u00B7 AgriScope'
        // Do not show the "account is ready" message again after a refresh.
        if (location.state) navigate('/login', { replace: true, state: null })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Already signed in: go straight to the app.
    if (sessionStorage.getItem('access_token')) {
        return <Navigate to="/yield-prediction" replace />
    }

    async function handleSubmit(event) {
        event.preventDefault()
        if (submitting) return

        setNotice(null)
        setSubmitting(true)

        try {
            const result = await loginUser({
                email: email.trim(),
                password,
            })

            // Keep the token for the pages that need it.
            sessionStorage.setItem('access_token', result.access_token)
            sessionStorage.setItem('user', JSON.stringify(result.user))

            navigate('/yield-prediction', { replace: true })
        } catch (error) {
            setNotice({
                type: 'error',
                text: plainError(error, 'We could not sign you in. Please try again.'),
            })
            setSubmitting(false)
        }
    }

    function edit(setter) {
        return (event) => {
            setter(event.target.value)
            if (notice?.type === 'error') setNotice(null)
        }
    }

    return (
        <main className="auth-page">
            <AuthShowcase
                label="AGRICULTURAL ANALYTICS"
                title="Understand your crops."
                accent=" Predict your yield."
                description="Explore crop performance across districts and seasons, see estimated yields, and ask questions about your farming data."
            />

            <section className="auth-panel">
                <div className="auth-form-wrap">
                    <Brand mobile />

                    <header className="form-heading">
                        <span className="eyebrow">WELCOME BACK</span>
                        <h2>Sign in</h2>
                        <p>Enter your account details to continue.</p>
                    </header>

                    <nav className="auth-tabs" aria-label="Account access">
                        <Link to="/login" className="auth-tab active" aria-current="page">
                            Sign in
                        </Link>
                        <Link to="/register" className="auth-tab">
                            Create account
                        </Link>
                    </nav>

                    <form className="auth-form" onSubmit={handleSubmit} aria-busy={submitting}>
                        <div className="form-field">
                            <label htmlFor="login-email">Email address</label>
                            <input
                                id="login-email"
                                name="email"
                                type="email"
                                inputMode="email"
                                autoCapitalize="none"
                                spellCheck={false}
                                placeholder="name@example.com"
                                autoComplete="email"
                                maxLength={254}
                                value={email}
                                onChange={edit(setEmail)}
                                required
                            />
                        </div>

                        <div className="form-field">
                            <label htmlFor="login-password">Password</label>
                            <div className="password-input">
                                <input
                                    id="login-password"
                                    name="password"
                                    type={showPassword ? 'text' : 'password'}
                                    placeholder="Enter your password"
                                    autoComplete="current-password"
                                    maxLength={72}
                                    value={password}
                                    onChange={edit(setPassword)}
                                    required
                                />
                                <button
                                    className="password-toggle"
                                    type="button"
                                    onClick={() => setShowPassword((current) => !current)}
                                    aria-pressed={showPassword}
                                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                                >
                                    {showPassword ? 'Hide' : 'Show'}
                                </button>
                            </div>
                        </div>

                        {notice && (
                            <p
                                className={`form-message form-message-${notice.type}`}
                                role={notice.type === 'error' ? 'alert' : 'status'}
                            >
                                {notice.text}
                            </p>
                        )}

                        <button className="submit-button" type="submit" disabled={submitting}>
                            {submitting ? (
                                <>
                                    <span className="btn-spinner" aria-hidden="true" /> Signing in
                                </>
                            ) : (
                                <>
                                    Sign in <Icon name="arrow" size={17} />
                                </>
                            )}
                        </button>
                    </form>

                    <p className="form-bottom">
                        Don&apos;t have an account? <Link to="/register">Create account</Link>
                    </p>
                </div>
            </section>
        </main>
    )
}