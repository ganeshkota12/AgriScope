import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { registerUser } from '../services/api'
import AuthShowcase, { Brand, Icon, plainError } from './AuthShowcase'
import './Register.css'

const PHONE_PATTERN = /^[+()\-\s\d]{7,20}$/

export default function Register() {
    const navigate = useNavigate()

    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [phone, setPhone] = useState('')
    const [age, setAge] = useState('')
    const [college, setCollege] = useState('')
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [showConfirmPassword, setShowConfirmPassword] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [notice, setNotice] = useState(null)

    useEffect(() => {
        document.title = 'Create account \u00B7 AgriScope'
    }, [])

    const passwordRules = [
        { label: 'At least 8 characters', valid: password.length >= 8 },
        { label: 'One uppercase letter', valid: /[A-Z]/.test(password) },
        { label: 'One lowercase letter', valid: /[a-z]/.test(password) },
        { label: 'One number', valid: /\d/.test(password) },
    ]

    const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword

    // Already signed in: go straight to the app.
    if (sessionStorage.getItem('access_token')) {
        return <Navigate to="/yield-prediction" replace />
    }

    function problem() {
        if (name.trim().length < 2) return 'Please enter your full name.'
        if (phone.trim() && !PHONE_PATTERN.test(phone.trim())) {
            return 'Enter a valid phone number, or leave it empty.'
        }
        if (age !== '' && (!Number.isInteger(Number(age)) || Number(age) < 1 || Number(age) > 120)) {
            return 'Enter an age between 1 and 120, or leave it empty.'
        }
        if (!passwordRules.every((rule) => rule.valid)) {
            return 'Please meet all the password requirements.'
        }
        if (password !== confirmPassword) return 'Your passwords do not match.'
        return ''
    }

    async function handleSubmit(event) {
        event.preventDefault()
        if (submitting) return

        const found = problem()
        if (found) {
            setNotice({ type: 'error', text: found })
            return
        }

        setNotice(null)
        setSubmitting(true)

        try {
            // The optional details are sent only when they were filled in.
            await registerUser({
                name: name.trim(),
                email: email.trim(),
                password,
                ...(phone.trim() ? { phone: phone.trim() } : {}),
                ...(age !== '' ? { age: Number(age) } : {}),
                ...(college.trim() ? { college: college.trim() } : {}),
            })

            navigate('/login', {
                replace: true,
                state: { registered: true, email: email.trim() },
            })
        } catch (error) {
            setNotice({
                type: 'error',
                text: plainError(error, 'We could not create your account. Please try again.'),
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
                label="YOUR AGRICULTURAL WORKSPACE"
                title="Make better sense of"
                accent=" every growing season."
                description="Bring crop performance, yield estimates and a farming assistant together in one place."
            />

            <section className="auth-panel register-panel">
                <div className="auth-form-wrap register-form-wrap">
                    <Brand mobile />

                    <header className="form-heading">
                        <span className="eyebrow">GET STARTED</span>
                        <h2>Create your account</h2>
                        <p>Enter your details to set up your workspace.</p>
                    </header>

                    <nav className="auth-tabs" aria-label="Account access">
                        <Link to="/login" className="auth-tab">
                            Sign in
                        </Link>
                        <Link to="/register" className="auth-tab active" aria-current="page">
                            Create account
                        </Link>
                    </nav>

                    <form className="auth-form" onSubmit={handleSubmit} aria-busy={submitting}>
                        <div className="form-field">
                            <label htmlFor="register-name">Full name</label>
                            <input
                                id="register-name"
                                name="name"
                                type="text"
                                placeholder="Enter your full name"
                                autoComplete="name"
                                maxLength={100}
                                value={name}
                                onChange={edit(setName)}
                                required
                            />
                        </div>

                        <div className="form-field">
                            <label htmlFor="register-email">Email address</label>
                            <input
                                id="register-email"
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

                        <div className="form-grid">
                            <div className="form-field">
                                <label htmlFor="register-phone">
                                    Phone number <span className="optional-label">(Optional)</span>
                                </label>
                                <input
                                    id="register-phone"
                                    name="phone"
                                    type="tel"
                                    placeholder="Phone number"
                                    autoComplete="tel"
                                    maxLength={20}
                                    value={phone}
                                    onChange={edit(setPhone)}
                                />
                            </div>

                            <div className="form-field">
                                <label htmlFor="register-age">
                                    Age <span className="optional-label">(Optional)</span>
                                </label>
                                <input
                                    id="register-age"
                                    name="age"
                                    type="number"
                                    inputMode="numeric"
                                    min="1"
                                    max="120"
                                    placeholder="Age"
                                    value={age}
                                    onChange={edit(setAge)}
                                />
                            </div>
                        </div>

                        <div className="form-field">
                            <label htmlFor="register-college">
                                College / Institution <span className="optional-label">(Optional)</span>
                            </label>
                            <input
                                id="register-college"
                                name="college"
                                type="text"
                                placeholder="Enter your institution"
                                autoComplete="organization"
                                maxLength={120}
                                value={college}
                                onChange={edit(setCollege)}
                            />
                        </div>

                        <div className="form-field">
                            <label htmlFor="register-password">Password</label>
                            <div className="password-input">
                                <input
                                    id="register-password"
                                    name="password"
                                    type={showPassword ? 'text' : 'password'}
                                    placeholder="Create a strong password"
                                    autoComplete="new-password"
                                    maxLength={72}
                                    aria-describedby="password-rules"
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

                            <div className="password-rules" id="password-rules">
                                <p className="rules-title">Your password should contain:</p>
                                <ul className="rules-grid">
                                    {passwordRules.map((rule) => (
                                        <li className={`rule ${rule.valid ? 'valid' : ''}`} key={rule.label}>
                                            <span aria-hidden="true">{rule.valid ? '\u2713' : '\u25CB'}</span>
                                            {rule.label}
                                            <span className="sr-only">{rule.valid ? ' (done)' : ' (not yet)'}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>

                        <div className="form-field">
                            <label htmlFor="register-confirm-password">Confirm password</label>
                            <div className="password-input">
                                <input
                                    id="register-confirm-password"
                                    name="confirmPassword"
                                    type={showConfirmPassword ? 'text' : 'password'}
                                    placeholder="Re-enter your password"
                                    autoComplete="new-password"
                                    maxLength={72}
                                    value={confirmPassword}
                                    onChange={edit(setConfirmPassword)}
                                    required
                                />
                                <button
                                    className="password-toggle"
                                    type="button"
                                    onClick={() => setShowConfirmPassword((current) => !current)}
                                    aria-pressed={showConfirmPassword}
                                    aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                                >
                                    {showConfirmPassword ? 'Hide' : 'Show'}
                                </button>
                            </div>

                            {confirmPassword && (
                                <span
                                    className={`match-message ${passwordsMatch ? 'valid-text' : ''}`}
                                    role="status"
                                >
                                    {passwordsMatch ? 'Passwords match' : 'Passwords do not match'}
                                </span>
                            )}
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
                                    <span className="btn-spinner" aria-hidden="true" /> Creating your account
                                </>
                            ) : (
                                <>
                                    Create account <Icon name="arrow" size={17} />
                                </>
                            )}
                        </button>
                    </form>

                    <p className="form-bottom">
                        Already have an account? <Link to="/login">Sign in</Link>
                    </p>
                </div>
            </section>
        </main>
    )
}