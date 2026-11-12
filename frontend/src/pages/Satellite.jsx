import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { displayDistrict, formatNumber, getJson } from './analysisApi.js'
import { AiLanguageSwitch, useAiLanguage } from './AiLanguage.jsx'
import './Satellite.css'

const API_URL = (import.meta.env?.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')

export default function Satellite() {
    const [data, setData] = useState(null)
    const [districts, setDistricts] = useState([])
    const [season, setSeason] = useState('')
    const [district, setDistrict] = useState('')
    const [shown, setShown] = useState(null)
    const [status, setStatus] = useState('loading')
    const [message, setMessage] = useState('')

    useEffect(() => {
        document.title = 'Satellite & NDVI \u00B7 AgriScope'
        getJson('/satellite/overview')
            .then((result) => {
                setData(result)
                setStatus('ready')
                setSeason(result.seasons[result.seasons.length - 1]?.label ?? '')
            })
            .catch((error) => { setStatus('error'); setMessage(error.message) })
        getJson('/dashboard/summary')
            .then((summary) => setDistricts([...new Set(summary.districts ?? [])].sort()))
            .catch(() => { })
    }, [])

    async function show() {
        if (!season) return
        let history = null
        if (district) {
            try {
                const detail = await getJson(`/satellite/overview?district=${encodeURIComponent(district)}`)
                history = detail.district?.history ?? null
            } catch {
                history = null
            }
        }
        setShown({ season, district, history })
    }

    const view = shown && data ? buildView(data, shown.season, shown.district, shown.history) : null

    return (
        <div className="sat-page">
            <header className="sat-head">
                <span className="sat-kicker">Satellite</span>
                <h1>How green are rice fields?</h1>
            </header>

            <section className="sat-filters" aria-labelledby="sat-choose-title">
                <h2 id="sat-choose-title" className="sat-sr">Choose</h2>
                <label className="sat-field"><span>Season</span>
                    <select value={season} onChange={(e) => setSeason(e.target.value)} disabled={!data}>
                        {data?.seasons.map((item) => <option key={item.label} value={item.label}>{item.label}</option>)}
                    </select>
                </label>
                <label className="sat-field"><span>District (optional)</span>
                    <select value={district} onChange={(e) => setDistrict(e.target.value)} disabled={!data}>
                        <option value="">All districts</option>
                        {districts.map((d) => <option key={d} value={d}>{displayDistrict(d)}</option>)}
                    </select>
                </label>
                <button type="button" className="sat-button" onClick={show} disabled={!data || !season}>Show</button>
            </section>

            {status === 'error' && <p className="sat-message" role="alert">{message}</p>}

            <div className="sat-layout">
                <main className="sat-main">
                    {!view && status === 'ready' && (
                        <section className="sat-card sat-empty"><p>Choose a season above, then click Show.</p></section>
                    )}

                    {view && (
                        <>
                            <section className="sat-card" aria-labelledby="sat-seasons">
                                <h2 id="sat-seasons">Greenness in each season</h2>
                                <p className="sat-answer">{view.headline}</p>
                                <div className="sat-chart" role="img" aria-label="Average greenness of rice in each season">
                                    <ResponsiveContainer width="100%" height={230}>
                                        <BarChart data={data.seasons} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                                            <CartesianGrid stroke="#e8edf3" strokeDasharray="3 3" vertical={false} />
                                            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} interval={0} />
                                            <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                                            <Tooltip formatter={(v, n, p) => [`${v} (from ${p.payload.min} to ${p.payload.max} across districts)`, 'Average greenness']} />
                                            <Bar dataKey="mean" radius={[4, 4, 0, 0]}>
                                                {data.seasons.map((item) => <Cell key={item.label} fill={item.label === view.season ? '#1f4d32' : '#9bb89f'} />)}
                                            </Bar>
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                                <p className="sat-legend">Bars show the average greenness of rice across the 13 districts, on a 0 to 1 scale. The selected season is darker.</p>
                            </section>

                            <section className="sat-card" aria-labelledby="sat-rank">
                                <h2 id="sat-rank">Districts in {view.season}</h2>
                                <p className="sat-answer">{view.rankSentence}</p>
                                <div className="sat-rank">
                                    {view.ranking.map((row) => (
                                        <div key={row.district} className={`sat-rk${row.district === view.district ? ' is-me' : ''}`}>
                                            <span className="sat-rk-n">{row.rank}</span>
                                            <span className="sat-rk-name">{displayDistrict(row.district)}</span>
                                            <span className="sat-rk-track"><i style={{ width: `${row.ndvi * 100}%` }} /></span>
                                            <b>{row.ndvi.toFixed(2)}</b>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            {view.districtHistory && (
                                <section className="sat-card" aria-labelledby="sat-history">
                                    <h2 id="sat-history">{displayDistrict(view.district)} across the seasons</h2>
                                    <table className="sat-table">
                                        <thead><tr><th scope="col">Season</th><th scope="col">Greenness</th><th scope="col">Rank</th><th scope="col">Compared with the average</th></tr></thead>
                                        <tbody>
                                            {view.districtHistory.map((row) => (
                                                <tr key={row.label}>
                                                    <th scope="row">{row.label}</th>
                                                    <td>{row.ndvi.toFixed(2)}</td>
                                                    <td>{row.rank} of {row.of}</td>
                                                    <td>{row.ndvi >= row.season_mean ? 'Above' : 'Below'} ({row.ndvi.toFixed(2)} vs {row.season_mean.toFixed(2)})</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </section>
                            )}

                            <section className="sat-card" aria-labelledby="sat-consistent">
                                <h2 id="sat-consistent">Which districts stay green across seasons?</h2>
                                <p className="sat-legend">Average position out of 13 across the six seasons. A low number means the district is consistently near the top.</p>
                                <table className="sat-table">
                                    <thead><tr><th scope="col">District</th><th scope="col">Average rank</th><th scope="col">Best to worst</th></tr></thead>
                                    <tbody>
                                        {data.consistency.map((row) => (
                                            <tr key={row.district}>
                                                <th scope="row">{displayDistrict(row.district)}</th>
                                                <td>{row.average_rank}</td>
                                                <td>{row.best_rank} to {row.worst_rank}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </section>

                            <section className="sat-card" aria-labelledby="sat-change">
                                <h2 id="sat-change">Kharif to Rabi: which districts change most?</h2>
                                <p className="sat-legend">Average change in greenness from Kharif to Rabi of the same year. Negative means Rabi is less green.</p>
                                <div className="sat-rank">
                                    {data.season_change.map((row) => (
                                        <div key={row.district} className="sat-rk">
                                            <span className="sat-rk-n"></span>
                                            <span className="sat-rk-name">{displayDistrict(row.district)}</span>
                                            <span className="sat-rk-track"><i style={{ width: `${Math.min(Math.abs(row.rabi_minus_kharif) * 200, 100)}%`, background: row.rabi_minus_kharif < 0 ? '#b9641e' : '#2f6fa3' }} /></span>
                                            <b>{row.rabi_minus_kharif > 0 ? '+' : ''}{row.rabi_minus_kharif.toFixed(2)}</b>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            {data.history_check && (
                                <section className="sat-card sat-warn" aria-labelledby="sat-history-check">
                                    <h2 id="sat-history-check">Recent greenness against past yield</h2>
                                    <p className="sat-answer">Rank correlation {data.history_check.rank_correlation} across {data.history_check.districts} districts.</p>
                                    <p className="sat-legend">{data.history_check.meaning}</p>
                                    <table className="sat-table">
                                        <thead><tr><th scope="col">District</th><th scope="col">Historical rice yield, Kharif 1997 to 2014 (kg/ha)</th><th scope="col">Kharif greenness, 2018 to 2022</th></tr></thead>
                                        <tbody>
                                            {data.history_check.rows.map((row) => (
                                                <tr key={row.district}>
                                                    <th scope="row">{displayDistrict(row.district)}</th>
                                                    <td>{row.historical_yield_kg_ha.toLocaleString('en-IN')}</td>
                                                    <td>{row.kharif_greenness.toFixed(2)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </section>
                            )}

                            <section className="sat-card" aria-labelledby="sat-yield">
                                <h2 id="sat-yield">Does greenness show yield?</h2>
                                <p className="sat-answer">{data.yield_check.meaning}</p>
                                <p className="sat-legend">Correlation {data.yield_check.correlation} from {data.yield_check.observations} district-seasons. A value near 0 means no straight-line link. Greenness shows how green the crop looks from space, not how much it yields.</p>
                            </section>
                        </>
                    )}
                </main>

                <SatChat data={data} view={view} />
            </div>
        </div>
    )
}

function buildView(data, season, district, history) {
    const ranking = data.rankings[season] ?? []
    const mine = district ? ranking.findIndex((row) => row.district === district.toUpperCase()) : -1
    const seasonInfo = data.seasons.find((item) => item.label === season)
    const best = data.seasons.reduce((a, b) => (b.mean > a.mean ? b : a))
    const tightest = data.seasons.reduce((a, b) => ((b.max - b.min) < (a.max - a.min) ? b : a))
    const headline = `${best.label} was the greenest season on average (${best.mean.toFixed(2)}). ${tightest.label} had the smallest gap between the greenest and least green district.`
    const rankSentence = mine >= 0
        ? `${displayDistrict(district)} ranks ${mine + 1} of ${ranking.length} in ${season}, with a greenness of ${ranking[mine].ndvi.toFixed(2)}. The average across districts is ${seasonInfo.mean.toFixed(2)}.`
        : `The greenest district in ${season} is ${displayDistrict(ranking[0]?.district)}, at ${ranking[0]?.ndvi.toFixed(2)}. The least green is ${displayDistrict(ranking[ranking.length - 1]?.district)}, at ${ranking[ranking.length - 1]?.ndvi.toFixed(2)}.`
    const hist = district ? history : null
    return {
        season,
        district: district ? district.toUpperCase() : null,
        headline,
        rankSentence,
        ranking,
        districtHistory: hist,
    }
}

function SatChat({ data, view }) {
    const [language, setLanguage] = useAiLanguage()
    const [messages, setMessages] = useState([])
    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
    const logRef = useRef(null)

    useEffect(() => {
        const log = logRef.current
        if (log) log.scrollTop = log.scrollHeight
    }, [messages, busy])

    const context = view && data ? satContext(data, view) : null

    async function send(text) {
        const question = String(text ?? '').trim()
        if (!question || busy || !context) return
        const history = messages.filter((m) => !m.error).slice(-6).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
        setMessages((previous) => [...previous, { role: 'user', content: question }])
        setInput('')
        setBusy(true)
        try {
            const token = sessionStorage.getItem('access_token')
            const response = await fetch(`${API_URL}/dashboard/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ question, mode: 'chat', language, history, page_context: context }),
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'The AI assistant could not answer. Please try again.')
            setMessages((previous) => [...previous, { role: 'assistant', content: payload.answer, language }])
        } catch (error) {
            const text = error.message === 'Failed to fetch' ? 'We could not reach the server. Please check your connection and try again.' : error.message
            setMessages((previous) => [...previous, { role: 'assistant', content: text, error: true }])
        } finally {
            setBusy(false)
        }
    }

    return (
        <aside className="sat-chat" aria-labelledby="sat-chat-title">
            <div className="sat-chat-head">
                <div>
                    <h2 id="sat-chat-title">AgriScope AI</h2>
                    <p>{context ? 'Ask about these results, or use a button below.' : 'Show a season first.'}</p>
                </div>
                <AiLanguageSwitch value={language} onChange={setLanguage} disabled={busy} />
            </div>
            {context && (
                <div className="sat-actions">
                    <button type="button" onClick={() => send('Explain these satellite results in simple English: what greenness shows, and what this season and district look like.')} disabled={busy}>Explain these results</button>
                    <button type="button" onClick={() => send('What does this greenness information mean for a farmer in this district? Give three short points in simple English.')} disabled={busy}>What does this mean for farmers?</button>
                </div>
            )}
            <div className="sat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
                {messages.map((message, index) => (
                    <div key={index} className={`sat-msg sat-msg-${message.role}${message.error ? ' sat-msg-error' : ''}`} lang={message.role === 'assistant' && message.language === 'telugu' ? 'te' : undefined}>
                        {message.role === 'assistant' && !message.error ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : <p>{message.content}</p>}
                    </div>
                ))}
                {busy && <div className="sat-msg sat-msg-assistant sat-typing">Thinking&hellip;</div>}
            </div>
            <form className="sat-composer" onSubmit={(e) => { e.preventDefault(); send(input) }}>
                <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={context ? 'Ask a question' : 'Show a season first'} maxLength={2000} disabled={!context || busy} aria-label="Message AgriScope AI" />
                <button type="submit" disabled={!context || busy || !input.trim()}>Send</button>
            </form>
        </aside>
    )
}

function satContext(data, view) {
    const top = view.ranking.slice(0, 3).map((r) => `${displayDistrict(r.district)} ${r.ndvi.toFixed(2)}`).join(', ')
    const seasons = data.seasons.map((s) => `${s.label} average ${s.mean.toFixed(2)}`).join('; ')
    const parts = [
        'Satellite greenness page. Rice NDVI on a 0 to 1 scale; higher means a greener crop canopy. This is not a yield measure.',
        `Seasons: ${seasons}.`,
        `Selected season ${view.season}: greenest districts ${top}.`,
        view.district && view.districtHistory
            ? `Selected district ${displayDistrict(view.district)}: ${view.districtHistory.map((h) => `${h.label} ${h.ndvi.toFixed(2)} (rank ${h.rank} of ${h.of})`).join(', ')}.`
            : 'No district selected.',
        `Earlier check: greenness and yield correlation ${data.yield_check.correlation} across ${data.yield_check.observations} district-seasons (no clear link).`,
    ]
    return parts.join(' ').slice(0, 1500)
}