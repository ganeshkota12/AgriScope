import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { displayDistrict, formatNumber, getJson } from './analysisApi.js'
import { AiLanguageSwitch, useAiLanguage } from './AiLanguage.jsx'
import './FieldConditions.css'

const API_URL = (import.meta.env?.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const TYPE_LABEL = { wet: 'Wet season', dry: 'Dry season', normal: 'Normal season' }
const TYPE_COLOR = { wet: '#2f6fa3', dry: '#b9641e', normal: '#43895b' }

export default function FieldConditions() {
    const [options, setOptions] = useState(null)
    const [crop, setCrop] = useState('')
    const [season, setSeason] = useState('')
    const [district, setDistrict] = useState('')
    const [year, setYear] = useState('')
    const [result, setResult] = useState(null)
    const [status, setStatus] = useState('idle')
    const [message, setMessage] = useState('')
    const [askRequest, setAskRequest] = useState(null)
    const [measure, setMeasure] = useState('yield')

    useEffect(() => {
        document.title = 'Field Conditions \u00B7 AgriScope'
        getJson('/dashboard/summary')
            .then((data) => setOptions({
                crops: [...new Set(data.crops ?? [])],
                seasons: [...new Set(data.seasons ?? [])].filter((s) => ['Kharif', 'Rabi'].includes(s)),
                districts: [...new Set(data.districts ?? [])].sort(),
            }))
            .catch((error) => setMessage(error.message))
    }, [])

    async function show() {
        if (!crop || !season || !district) {
            setMessage('Choose a crop, season and district first.')
            return
        }
        setStatus('loading')
        setMessage('')
        try {
            const params = new URLSearchParams({ district, crop, season })
            if (year) params.set('year', year)
            setResult(await getJson(`/field/overview?${params}`))
            setStatus('ready')
        } catch (error) {
            setResult(null)
            setStatus('error')
            setMessage(error.message)
        }
    }

    const chosen = result?.selected_year
    const yearPicked = Boolean(year)
    const rainDiff = chosen ? Math.round(((chosen.rainfall_mm - result.usual_rainfall_mm) / result.usual_rainfall_mm) * 100) : null
    const types = result?.by_year_type
    const withYield = result ? result.years.filter((item) => item.yield_kg_ha != null) : []
    const best = withYield.length ? withYield.reduce((a, b) => (b.yield_kg_ha > a.yield_kg_ha ? b : a)) : null
    const lowest = withYield.length ? withYield.reduce((a, b) => (b.yield_kg_ha < a.yield_kg_ha ? b : a)) : null
    const recent = result ? result.years.slice(-6).reverse() : []

    return (
        <div className="fc-page">
            <header className="fc-head">
                <span className="fc-kicker">Field conditions</span>
                <h1>Rain, yield and soil for your district</h1>
            </header>

            <section className="fc-filters" aria-labelledby="fc-choose-title">
                <h2 id="fc-choose-title" className="fc-sr">Choose</h2>
                <label className="fc-field"><span>Crop</span>
                    <select value={crop} onChange={(e) => setCrop(e.target.value)} disabled={!options}>
                        <option value="" disabled>Select a crop</option>
                        {options?.crops.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                </label>
                <label className="fc-field"><span>Season</span>
                    <select value={season} onChange={(e) => setSeason(e.target.value)} disabled={!options}>
                        <option value="" disabled>Select a season</option>
                        {options?.seasons.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                </label>
                <label className="fc-field"><span>District</span>
                    <select value={district} onChange={(e) => setDistrict(e.target.value)} disabled={!options}>
                        <option value="" disabled>Select a district</option>
                        {options?.districts.map((d) => <option key={d} value={d}>{displayDistrict(d)}</option>)}
                    </select>
                </label>
                <label className="fc-field"><span>Year (optional)</span>
                    <select value={year} onChange={(e) => setYear(e.target.value)} disabled={!options}>
                        <option value="">Not chosen</option>
                        {Array.from({ length: 18 }, (_, i) => 1997 + i).map((y) => <option key={y} value={y}>{y}</option>)}
                    </select>
                </label>
                <button type="button" className="fc-button" onClick={show} disabled={status === 'loading'}>
                    {status === 'loading' ? 'Loading\u2026' : 'Show'}
                </button>
            </section>
            {message && <p className="fc-message" role="alert">{message}</p>}

            <div className="fc-layout">
                <main className="fc-main">
                    {status !== 'ready' && (
                        <section className="fc-card fc-empty">
                            <p>Choose a crop, season and district above, then click Show.</p>
                        </section>
                    )}

                    {status === 'ready' && result && (
                        <>
                            <section className="fc-card fc-summary" aria-labelledby="fc-season">
                                <h2 id="fc-season">{yearPicked && chosen ? `${chosen.year}: ${TYPE_LABEL[chosen.kind].toLowerCase()} in ${displayDistrict(result.district)}` : `${displayDistrict(result.district)}: ${result.crop}, ${result.season}`}</h2>
                                {!yearPicked && <p className="fc-muted">Choose a year above to see how that season compared with usual.</p>}
                                {yearPicked && !chosen && <p className="fc-muted">There is no record for this district, crop and season in {year}.</p>}
                                {yearPicked && chosen && (
                                    <>
                                        <p className="fc-answer">
                                            {Math.abs(rainDiff) < result.band_percent
                                                ? `Rainfall was about usual.`
                                                : `Rainfall was ${Math.abs(rainDiff)}% ${rainDiff > 0 ? 'more' : 'less'} than usual.`}
                                            {chosen.yield_kg_ha != null && ` The yield was ${formatNumber(chosen.yield_kg_ha, 0)} kg per hectare.`}
                                        </p>
                                        <div className="fc-stats">
                                            <div><span>Rainfall</span><b>{formatNumber(chosen.rainfall_mm, 0)} mm</b><small>usual {formatNumber(result.usual_rainfall_mm, 0)} mm</small></div>
                                            <div><span>Temperature</span><b>{formatNumber(chosen.mean_temperature_c, 1)} °C</b></div>
                                            <div><span>Humidity</span><b>{formatNumber(chosen.humidity_pct, 0)} %</b></div>
                                            <div><span>Yield</span><b>{formatNumber(chosen.yield_kg_ha, 0)} kg/ha</b><small>{TYPE_LABEL[chosen.kind]}</small></div>
                                        </div>
                                    </>
                                )}
                            </section>

                            <section className="fc-card" aria-labelledby="fc-types">
                                <h2 id="fc-types">Dry, normal and wet seasons</h2>
                                <p className="fc-legend">A dry season had at least {result.band_percent}% less rain than this district's usual. A wet season had at least {result.band_percent}% more. Other seasons are normal.</p>
                                <div className="fc-types">
                                    {['dry', 'normal', 'wet'].map((kind) => (
                                        <div key={kind} className={`fc-type fc-type-${kind}`}>
                                            <span>{TYPE_LABEL[kind]}s</span>
                                            <b>{types[kind].average_yield_kg_ha == null ? 'No years' : `${formatNumber(types[kind].average_yield_kg_ha, 0)} kg/ha`}</b>
                                            <small>average yield, {types[kind].years} {types[kind].years === 1 ? 'year' : 'years'}</small>
                                        </div>
                                    ))}
                                </div>
                                <p className="fc-answer">{yieldSentence(types, result.district)}</p>
                            </section>

                            <section className="fc-card" aria-labelledby="fc-history">
                                <div className="fc-card-head">
                                    <h2 id="fc-history">Year by year</h2>
                                    <div className="fc-toggle" role="group" aria-label="Chart shows">
                                        <button type="button" aria-pressed={measure === 'yield'} onClick={() => setMeasure('yield')}>Yield</button>
                                        <button type="button" aria-pressed={measure === 'rain'} onClick={() => setMeasure('rain')}>Rainfall</button>
                                    </div>
                                </div>
                                <div className="fc-chart" role="img" aria-label={measure === 'yield' ? 'Yield in each year' : 'Rainfall in each year'}>
                                    <ResponsiveContainer width="100%" height={240}>
                                        <BarChart data={result.years} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                                            <CartesianGrid stroke="#e8edf3" strokeDasharray="3 3" vertical={false} />
                                            <XAxis dataKey="year" tick={{ fontSize: 11 }} tickLine={false} interval={0} />
                                            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => formatNumber(v, 0)} />
                                            <Tooltip formatter={(v, n, p) => [
                                                measure === 'yield' ? `${formatNumber(v, 0)} kg/ha` : `${formatNumber(v, 0)} mm`,
                                                `${TYPE_LABEL[p.payload.kind]}`,
                                            ]} />
                                            {chosen && <ReferenceLine x={chosen.year} stroke="#5f6e62" strokeDasharray="4 4" />}
                                            <Bar dataKey={measure === 'yield' ? 'yield_kg_ha' : 'rainfall_mm'} radius={[4, 4, 0, 0]}>
                                                {result.years.map((item) => <Cell key={item.year} fill={TYPE_COLOR[item.kind]} />)}
                                            </Bar>
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                                <p className="fc-legend">Colours: blue is a wet season, orange a dry season, green a normal season. Yield is in kg per hectare; rainfall is in millimetres.</p>
                                <div className="fc-highlights">
                                    {best && <div><span>Best year</span><b>{best.year}</b><small>{formatNumber(best.yield_kg_ha, 0)} kg/ha, {TYPE_LABEL[best.kind].toLowerCase()}</small></div>}
                                    {lowest && <div><span>Lowest year</span><b>{lowest.year}</b><small>{formatNumber(lowest.yield_kg_ha, 0)} kg/ha, {TYPE_LABEL[lowest.kind].toLowerCase()}</small></div>}
                                </div>
                            </section>

                            <section className="fc-card" aria-labelledby="fc-recent">
                                <h2 id="fc-recent">Last six years</h2>
                                <table className="fc-table">
                                    <thead><tr><th scope="col">Year</th><th scope="col">Rainfall</th><th scope="col">Season</th><th scope="col">Yield (kg/ha)</th></tr></thead>
                                    <tbody>
                                        {recent.map((item) => (
                                            <tr key={item.year}>
                                                <th scope="row">{item.year}</th>
                                                <td>{formatNumber(item.rainfall_mm, 0)} mm</td>
                                                <td>{TYPE_LABEL[item.kind]}</td>
                                                <td>{item.yield_kg_ha == null ? 'No record' : formatNumber(item.yield_kg_ha, 0)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </section>

                            <section className="fc-card" aria-labelledby="fc-rank">
                                <h2 id="fc-rank">How this district compares</h2>
                                {result.district_average_yield_kg_ha != null ? (
                                    <>
                                        <Compare label={`${displayDistrict(result.district)} (average)`} value={result.district_average_yield_kg_ha} max={result.top_district_yield_kg_ha} tone="us" />
                                        <Compare label="State average" value={result.state_average_yield_kg_ha} max={result.top_district_yield_kg_ha} tone="state" />
                                        <Compare label={`Top district: ${displayDistrict(result.top_district)}`} value={result.top_district_yield_kg_ha} max={result.top_district_yield_kg_ha} tone="top" />
                                        <p className="fc-legend">Average yield over all recorded years, in kg per hectare. {displayDistrict(result.district)} ranks {result.rank} out of {result.district_count} districts.</p>
                                    </>
                                ) : (
                                    <p className="fc-muted">There is no yield record for this district to compare.</p>
                                )}
                            </section>

                            <section className="fc-card" aria-labelledby="fc-soil">
                                <h2 id="fc-soil">Soil</h2>
                                <p className="fc-legend">Estimates for the top layer of soil. They are the same every year.</p>
                                <div className="fc-soil">
                                    {result.soil.map((item) => (
                                        <div className="fc-soil-card" key={item.key}>
                                            <span>{item.label}</span>
                                            <b>{formatNumber(item.value, 1)} <small>{item.unit}</small></b>
                                            <em>{item.reading}</em>
                                            <p>{item.meaning}</p>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        </>
                    )}
                </main>

                <FieldChat result={result} year={yearPicked ? year : ''} onRequest={askRequest} onConsumed={() => setAskRequest(null)} />
            </div>
        </div>
    )
}

function Compare({ label, value, max, tone }) {
    if (value == null || !max) return null
    const width = Math.max((value / max) * 100, 2)
    return (
        <div className={`fc-compare fc-compare-${tone}`}>
            <span>{label}</span>
            <span className="fc-compare-track"><i style={{ width: `${width}%` }} /></span>
            <b>{formatNumber(value, 0)}</b>
        </div>
    )
}

function FieldChat({ result, year, onRequest, onConsumed }) {
    const [language, setLanguage] = useAiLanguage()
    const [messages, setMessages] = useState([])
    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
    const logRef = useRef(null)

    useEffect(() => {
        const log = logRef.current
        if (log) log.scrollTop = log.scrollHeight
    }, [messages, busy])

    const context = result ? fieldContext(result, year) : null

    useEffect(() => {
        if (!onRequest || !context) return
        onConsumed()
        send(ASK_TEXT[onRequest.kind])
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onRequest])

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
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'The AI assistant could not answer. Please try again.')
            setMessages((previous) => [...previous, { role: 'assistant', content: data.answer, language }])
        } catch (error) {
            const text = error.message === 'Failed to fetch'
                ? 'We could not reach the server. Please check your connection and try again.'
                : error.message
            setMessages((previous) => [...previous, { role: 'assistant', content: text, error: true }])
        } finally {
            setBusy(false)
        }
    }

    return (
        <aside className="fc-chat" aria-labelledby="fc-chat-title">
            <div className="fc-chat-head">
                <div>
                    <h2 id="fc-chat-title">AgriScope AI</h2>
                    <p>{context ? 'Ask about this page, or use a button below.' : 'Show a district first.'}</p>
                </div>
                <AiLanguageSwitch value={language} onChange={setLanguage} disabled={busy} />
            </div>

            {context && (
                <div className="fc-actions">
                    <button type="button" onClick={() => send(ASK_TEXT.explain)} disabled={busy}>Explain this season</button>
                    <button type="button" onClick={() => send(ASK_TEXT.check)} disabled={busy}>What should I check now?</button>
                </div>
            )}

            <div className="fc-chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
                {messages.map((message, index) => (
                    <div
                        key={index}
                        className={`fc-msg fc-msg-${message.role}${message.error ? ' fc-msg-error' : ''}`}
                        lang={message.role === 'assistant' && message.language === 'telugu' ? 'te' : undefined}
                    >
                        {message.role === 'assistant' && !message.error
                            ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                            : <p>{message.content}</p>}
                    </div>
                ))}
                {busy && <div className="fc-msg fc-msg-assistant fc-typing">Thinking&hellip;</div>}
            </div>

            <form className="fc-composer" onSubmit={(e) => { e.preventDefault(); send(input) }}>
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={context ? 'Ask a question' : 'Show a district first'}
                    maxLength={2000}
                    disabled={!context || busy}
                    aria-label="Message AgriScope AI"
                />
                <button type="submit" disabled={!context || busy || !input.trim()}>Send</button>
            </form>
        </aside>
    )
}

const ASK_TEXT = {
    explain: 'Explain this season in simple English: was it dry, normal or wet, and what that may mean for the crop. Keep it short.',
    check: 'Based on this page, what should I check or do before the next season? Give three short points in simple English.',
}

function fieldContext(result, year) {
    const soil = result.soil.map((s) => `${s.label} ${s.value} ${s.unit} (${s.reading})`).join('; ')
    const chosen = result.selected_year
    const t = result.by_year_type
    const parts = [
        `Field conditions page for ${displayDistrict(result.district)}, ${result.crop}, ${result.season} season.`,
        `Usual growing-season rainfall ${formatNumber(result.usual_rainfall_mm, 0)} mm. Dry season means at least ${result.band_percent}% less rain than usual, wet means at least ${result.band_percent}% more.`,
        `Average yield in dry seasons ${t.dry.average_yield_kg_ha ?? 'no data'} kg/ha (${t.dry.years} years), normal seasons ${t.normal.average_yield_kg_ha ?? 'no data'} kg/ha (${t.normal.years} years), wet seasons ${t.wet.average_yield_kg_ha ?? 'no data'} kg/ha (${t.wet.years} years).`,
        `District average ${result.district_average_yield_kg_ha ?? 'no data'} kg/ha; state average ${result.state_average_yield_kg_ha ?? 'no data'} kg/ha; top district ${displayDistrict(result.top_district)} at ${result.top_district_yield_kg_ha} kg/ha.`,
        `Soil (estimates): ${soil}.`,
    ]
    if (year && chosen) {
        parts.push(`Chosen year ${year}: rainfall ${chosen.rainfall_mm} mm, ${TYPE_LABEL[chosen.kind].toLowerCase()}, yield ${chosen.yield_kg_ha} kg/ha.`)
    } else if (year) {
        parts.push(`Chosen year ${year} has no record for this district.`)
    }
    return parts.join(' ').slice(0, 1500)
}

function yieldSentence(types, district) {
    const name = displayDistrict(district)
    const dry = types.dry.average_yield_kg_ha
    const wet = types.wet.average_yield_kg_ha
    if (dry == null || wet == null) return `There are not enough dry and wet seasons in the records for ${name} to compare them.`
    const direction = wet < dry ? 'lower' : 'higher'
    return `In wet seasons, ${name} averaged ${formatNumber(Math.abs(wet - dry), 0)} kg per hectare ${direction} than in dry seasons. This is what happened in past years. It does not prove that rain caused the difference.`
}