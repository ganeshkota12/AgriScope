import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './Profile.css'

const API_URL = (import.meta.env?.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const PHONE_PATTERN = /^[+()\-\s\d]{7,20}$/

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

// Talks to the server as the signed-in person.
async function request(path, { method = 'GET', body } = {}) {
    const token = sessionStorage.getItem('access_token')
    let response
    try {
        response = await fetch(`${API_URL}${path}`, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        })
    } catch (error) {
        console.warn('AgriScope: the server could not be reached', error)
        throw new Error('We could not reach the server. Please check your connection and try again.')
    }

    let payload = null
    try {
        payload = await response.json()
    } catch {
        payload = null
    }

    if (!response.ok) {
        const detail = payload?.detail
        const error = new Error(
            typeof detail === 'string' && detail ? detail : 'Something went wrong. Please try again.'
        )
        error.status = response.status
        throw error
    }
    return payload
}

function initials(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return String(name ?? '').trim().slice(0, 2).toUpperCase() || '?'
}

function memberSince(value) {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

const toForm = (profile) => ({
    name: profile?.name ?? '',
    phone: profile?.phone ?? '',
    age: profile?.age == null ? '' : String(profile.age),
    college: profile?.college ?? '',
})

function districtName(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
        .replace(/\bSpsr\b/g, 'SPSR')
}

/* Saved dashboard comparisons: open one on the dashboard, or remove it. */
function SavedComparisons({ onSessionEnd }) {
    const navigate = useNavigate()
    const [list, setList] = useState({ status: 'loading', items: [], limit: 10 })
    const [message, setMessage] = useState('')

    const load = useCallback(async () => {
        try {
            const data = await request('/saved-comparisons')
            setList({ status: 'ready', items: data.items, limit: data.limit })
        } catch (error) {
            if (error.status === 401) return onSessionEnd()
            setList((current) => ({ ...current, status: 'error' }))
            setMessage(error.message)
        }
    }, [onSessionEnd])

    useEffect(() => {
        load()
    }, [load])

    function open(item) {
        // The dashboard reopens whatever selection is stored for this session.
        sessionStorage.setItem(
            'agriscope-dashboard-analysis',
            JSON.stringify({
                crop: item.crop,
                season: item.season,
                year: item.year,
                district_a: item.district_a,
                district_b: item.district_b,
            })
        )
        navigate('/dashboard')
    }

    async function remove(item) {
        setMessage('')
        try {
            await request(`/saved-comparisons/${item.id}`, { method: 'DELETE' })
            setList((current) => ({ ...current, items: current.items.filter((row) => row.id !== item.id) }))
        } catch (error) {
            if (error.status === 401) return onSessionEnd()
            setMessage(error.message)
        }
    }

    return (
        <section className="pf-card" aria-labelledby="pf-saved-title">
            <header className="pf-head">
                <div>
                    <h2 id="pf-saved-title">Saved comparisons</h2>
                    <p>
                        {list.status === 'ready'
                            ? `${list.items.length} of ${list.limit} saved. Open one to see it on the dashboard.`
                            : 'Open one to see it on the dashboard.'}
                    </p>
                </div>
            </header>

            {list.status === 'loading' && <p className="pf-muted">Loading your saved comparisons{'\u2026'}</p>}

            {list.status === 'ready' && list.items.length === 0 && (
                <p className="pf-muted">
                    Nothing saved yet. Compare two districts on the dashboard and click Save comparison.
                </p>
            )}

            {list.status === 'ready' && list.items.length > 0 && (
                <ul className="pf-saved">
                    {list.items.map((item) => (
                        <li className="pf-saved-item" key={item.id}>
                            <div>
                                <strong>
                                    {districtName(item.district_a)} vs {districtName(item.district_b)}
                                </strong>
                                <span>
                                    {item.crop}, {item.season} {item.year}
                                </span>
                            </div>
                            <div className="pf-saved-actions">
                                <button type="button" className="pf-button" onClick={() => open(item)}>
                                    Open
                                </button>
                                <button
                                    type="button"
                                    className="pf-button"
                                    onClick={() => remove(item)}
                                    aria-label={`Remove ${districtName(item.district_a)} vs ${districtName(item.district_b)}`}
                                >
                                    Remove
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {list.status === 'error' && (
                <button type="button" className="pf-button" onClick={load}>
                    Try again
                </button>
            )}
            {message && (
                <p className="pf-message pf-message-error" role="alert">
                    {message}
                </p>
            )}
        </section>
    )
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function Profile() {
    const navigate = useNavigate()

    const [profile, setProfile] = useState(null)
    const [status, setStatus] = useState('loading')
    const [loadError, setLoadError] = useState('')

    const [editing, setEditing] = useState(false)
    const [form, setForm] = useState(toForm(null))
    const [saving, setSaving] = useState(false)
    const [notice, setNotice] = useState(null)

    // The login has run out (or is not valid): go back to Sign in.
    const endSession = useCallback(() => {
        sessionStorage.removeItem('access_token')
        sessionStorage.removeItem('user')
        navigate('/login', { replace: true, state: { expired: true } })
    }, [navigate])

    const load = useCallback(async () => {
        setStatus('loading')
        setLoadError('')
        try {
            const data = await request('/profile')
            setProfile(data)
            setStatus('ready')
        } catch (error) {
            if (error.status === 401) {
                endSession()
                return
            }
            setLoadError(error.message)
            setStatus('error')
        }
    }, [endSession])

    useEffect(() => {
        load()
    }, [load])

    const dirty = useMemo(() => {
        if (!profile) return false
        const original = toForm(profile)
        return Object.keys(original).some((key) => original[key] !== form[key].trim())
    }, [profile, form])

    function startEditing() {
        setForm(toForm(profile))
        setNotice(null)
        setEditing(true)
    }

    function cancelEditing() {
        setEditing(false)
        setNotice(null)
    }

    function change(field) {
        return (event) => {
            setForm((current) => ({ ...current, [field]: event.target.value }))
            if (notice?.type === 'error') setNotice(null)
        }
    }

    function problem() {
        if (form.name.trim().length < 2) return 'Please enter your full name.'
        if (form.phone.trim() && !PHONE_PATTERN.test(form.phone.trim())) {
            return 'Enter a valid phone number, or leave it empty.'
        }
        if (form.age !== '' && (!Number.isInteger(Number(form.age)) || Number(form.age) < 1 || Number(form.age) > 120)) {
            return 'Enter an age between 1 and 120, or leave it empty.'
        }
        return ''
    }

    async function save(event) {
        event.preventDefault()
        if (saving || !dirty) return

        const found = problem()
        if (found) {
            setNotice({ type: 'error', text: found })
            return
        }

        setSaving(true)
        setNotice(null)
        try {
            const updated = await request('/profile', {
                method: 'PATCH',
                body: {
                    name: form.name.trim(),
                    phone: form.phone.trim() || null,
                    age: form.age === '' ? null : Number(form.age),
                    college: form.college.trim() || null,
                },
            })
            setProfile(updated)
            setEditing(false)
            setNotice({ type: 'success', text: 'Your details have been saved.' })

            // Keep the name that is stored for this session up to date.
            try {
                const stored = JSON.parse(sessionStorage.getItem('user') || 'null')
                if (stored) sessionStorage.setItem('user', JSON.stringify({ ...stored, name: updated.name }))
            } catch {
                // Not important: the name is read from the server next time.
            }
        } catch (error) {
            if (error.status === 401) {
                endSession()
                return
            }
            setNotice({ type: 'error', text: error.message })
        } finally {
            setSaving(false)
        }
    }

    /* ----- render ----- */

    if (status === 'loading') {
        return (
            <div className="pf-page" aria-busy="true">
                <div className="pf-card pf-skeleton" aria-label="Loading your profile">
                    <span className="pf-skel-avatar" />
                    <span className="pf-skel-line pf-skel-wide" />
                    <span className="pf-skel-line" />
                </div>
                <div className="pf-card pf-skeleton">
                    {[0, 1, 2, 3, 4].map((row) => (
                        <span className="pf-skel-line" key={row} />
                    ))}
                </div>
            </div>
        )
    }

    if (status === 'error') {
        return (
            <div className="pf-page">
                <div className="pf-card pf-alert" role="alert">
                    <p>{loadError}</p>
                    <button type="button" className="pf-button" onClick={load}>
                        Try again
                    </button>
                </div>
            </div>
        )
    }

    const since = memberSince(profile.memberSince)
    const rows = [
        ['Full name', profile.name],
        ['Email address', profile.email],
        ['Phone number', profile.phone],
        ['Age', profile.age == null ? null : String(profile.age)],
        ['College / institution', profile.college],
    ]

    return (
        <div className="pf-page">
            <section className="pf-card pf-identity" aria-label="About you">
                <span className="pf-avatar" aria-hidden="true">
                    {initials(profile.name)}
                </span>
                <div className="pf-identity-text">
                    <h1>{profile.name}</h1>
                    <p>{profile.email}</p>
                    {since && <span className="pf-since">Member since {since}</span>}
                </div>
            </section>

            {notice?.type === 'success' && (
                <p className="pf-message pf-message-success" role="status">
                    {notice.text}
                </p>
            )}

            <section className="pf-card" aria-labelledby="pf-details-title">
                <header className="pf-head">
                    <div>
                        <h2 id="pf-details-title">Your details</h2>
                        <p>{editing ? 'Change what you like, then save.' : 'The basic details on your account.'}</p>
                    </div>
                    {!editing && (
                        <button type="button" className="pf-button" onClick={startEditing}>
                            Edit details
                        </button>
                    )}
                </header>

                {editing ? (
                    <form className="pf-form" onSubmit={save} aria-busy={saving}>
                        <div className="pf-field">
                            <label htmlFor="pf-name">Full name</label>
                            <input
                                id="pf-name"
                                type="text"
                                autoComplete="name"
                                maxLength={100}
                                value={form.name}
                                onChange={change('name')}
                                required
                            />
                        </div>

                        <div className="pf-field">
                            <label htmlFor="pf-email">Email address</label>
                            <input id="pf-email" type="email" value={profile.email} disabled readOnly aria-describedby="pf-email-note" />
                            <span className="pf-note" id="pf-email-note">
                                Your email is how you sign in, so it cannot be changed here.
                            </span>
                        </div>

                        <div className="pf-grid">
                            <div className="pf-field">
                                <label htmlFor="pf-phone">
                                    Phone number <span className="pf-optional">(Optional)</span>
                                </label>
                                <input
                                    id="pf-phone"
                                    type="tel"
                                    autoComplete="tel"
                                    maxLength={20}
                                    value={form.phone}
                                    onChange={change('phone')}
                                />
                            </div>

                            <div className="pf-field">
                                <label htmlFor="pf-age">
                                    Age <span className="pf-optional">(Optional)</span>
                                </label>
                                <input
                                    id="pf-age"
                                    type="number"
                                    inputMode="numeric"
                                    min="1"
                                    max="120"
                                    value={form.age}
                                    onChange={change('age')}
                                />
                            </div>
                        </div>

                        <div className="pf-field">
                            <label htmlFor="pf-college">
                                College / institution <span className="pf-optional">(Optional)</span>
                            </label>
                            <input
                                id="pf-college"
                                type="text"
                                autoComplete="organization"
                                maxLength={120}
                                value={form.college}
                                onChange={change('college')}
                            />
                        </div>

                        {notice?.type === 'error' && (
                            <p className="pf-message pf-message-error" role="alert">
                                {notice.text}
                            </p>
                        )}

                        <div className="pf-actions">
                            <button type="submit" className="pf-button pf-button-primary" disabled={saving || !dirty}>
                                {saving ? (
                                    <>
                                        <span className="pf-spinner" aria-hidden="true" /> Saving
                                    </>
                                ) : (
                                    'Save changes'
                                )}
                            </button>
                            <button type="button" className="pf-button" onClick={cancelEditing} disabled={saving}>
                                Cancel
                            </button>
                        </div>
                    </form>
                ) : (
                    <dl className="pf-details">
                        {rows.map(([label, value]) => (
                            <div className="pf-row" key={label}>
                                <dt>{label}</dt>
                                <dd>{value ? value : <span className="pf-empty">Not added</span>}</dd>
                            </div>
                        ))}
                    </dl>
                )}
            </section>

            <SavedComparisons onSessionEnd={endSession} />
        </div>
    )
}