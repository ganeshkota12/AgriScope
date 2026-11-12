import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./YieldPrediction.css";
import { AiLanguageSwitch, useAiLanguage } from "./AiLanguage.jsx";

/* -------------------------------------------------------------------------- */
/*  Setup                                                                     */
/* -------------------------------------------------------------------------- */

const API_URL = (import.meta.env?.VITE_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

const CHAT_STORAGE_KEY = "agriscope-yield-chat";
const CHAT_HISTORY_TURNS = 6;
const CHAT_STORED_MESSAGES = 40;

const FIELDS = ["crop", "district", "season", "year"];
const EMPTY_FORM = { crop: "", district: "", season: "", year: "" };
const FIELD_LABELS = { crop: "crop", district: "district", season: "season", year: "year" };

const SpeechRecognition =
    typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function titleCase(text) {
    return String(text ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function displayDistrict(name) {
    return titleCase(name).replace(/\bSpsr\b/g, "SPSR");
}

function number(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "Not available";
    return n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function uniqueSorted(values, numeric = false) {
    const list = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
    return numeric ? list.sort((a, b) => Number(a) - Number(b)) : list.sort((a, b) => a.localeCompare(b));
}

async function request(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        const token = sessionStorage.getItem("access_token");
        response = await fetch(`${API_URL}${path}`, {
            method,
            headers: {
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error("That took too long. Please try again.");
        }
        console.warn("AgriScope: the server could not be reached", error);
        throw new Error("We could not reach the server. Please check your connection and try again.");
    } finally {
        clearTimeout(timer);
    }

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }
    if (!response.ok) {
        const detail = payload?.detail;
        const message = typeof detail === "string" ? detail : "";
        const error = new Error(message || "Something went wrong. Please try again.");
        error.status = response.status;
        throw error;
    }
    return payload;
}

function loadChat() {
    try {
        const stored = JSON.parse(sessionStorage.getItem(CHAT_STORAGE_KEY) || "[]");
        return Array.isArray(stored) ? stored : [];
    } catch {
        return [];
    }
}

let counter = 0;
function newId() {
    counter += 1;
    return `${Date.now().toString(36)}-${counter}`;
}

// Plain text for reading aloud: drop Markdown symbols.
function speakable(text) {
    return String(text).replace(/[*_`#>]/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1");
}

/* -------------------------------------------------------------------------- */
/*  Icons                                                                     */
/* -------------------------------------------------------------------------- */

function Icon({ name, size = 18 }) {
    const props = {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
    };
    switch (name) {
        case "send":
            return (
                <svg {...props}>
                    <path d="m22 2-7 20-4-9-9-4z" />
                    <path d="M22 2 11 13" />
                </svg>
            );
        case "mic":
            return (
                <svg {...props}>
                    <rect x="9" y="3" width="6" height="12" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
            );
        case "speaker":
            return (
                <svg {...props}>
                    <path d="M4 9v6h4l5 4V5L8 9H4z" />
                    <path d="M16 9a4 4 0 0 1 0 6" />
                </svg>
            );
        case "spark":
            return (
                <svg {...props}>
                    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
                    <path d="m12 7 1.8 3.2L17 12l-3.2 1.8L12 17l-1.8-3.2L7 12z" />
                </svg>
            );
        case "chart":
            return (
                <svg {...props}>
                    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
                </svg>
            );
        case "layers":
            return (
                <svg {...props}>
                    <path d="m12 3 9 5-9 5-9-5 9-5z" />
                    <path d="m3 13 9 5 9-5" />
                </svg>
            );
        case "satellite":
            return (
                <svg {...props}>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M4 12a8 8 0 0 1 8-8M4 12a8 8 0 0 0 8 8M20 12a8 8 0 0 0-8-8M20 12a8 8 0 0 1-8 8" />
                </svg>
            );
        case "sprout":
            return (
                <svg {...props}>
                    <path d="M12 21v-9" />
                    <path d="M12 12c0-4 2.5-6.5 7-6.5 0 4-2.5 6.5-7 6.5z" />
                    <path d="M12 14.5C12 11 9.5 9 5 9c0 3.5 2.5 5.5 7 5.5z" />
                </svg>
            );
        case "arrow":
            return (
                <svg {...props}>
                    <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
            );
        default:
            return null;
    }
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function YieldPrediction() {
    const [combos, setCombos] = useState([]);
    const [optionsStatus, setOptionsStatus] = useState("loading");
    const [form, setForm] = useState(EMPTY_FORM);

    const [result, setResult] = useState(null);
    const [recorded, setRecorded] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const [messages, setMessages] = useState(loadChat);
    const [aiLanguage, setAiLanguage] = useAiLanguage();
    const [input, setInput] = useState("");
    const [pending, setPending] = useState(false);
    const [listening, setListening] = useState(false);
    const [speakingId, setSpeakingId] = useState(null);

    const logRef = useRef(null);
    const inputRef = useRef(null);
    const recognitionRef = useRef(null);

    /* ----- options ----- */

    const loadOptions = useCallback(async () => {
        setOptionsStatus("loading");
        try {
            const data = await request("/predict/options");
            let list = (data.combinations ?? [])
                .map((c) => ({
                    crop: String(c.Crop ?? "").trim(),
                    district: String(c.District_Name ?? "").trim(),
                    season: String(c.Season ?? "").trim(),
                    year: String(c.Crop_Year ?? "").trim(),
                }))
                .filter((c) => c.crop && c.district && c.season && c.year);

            // Older servers send only the lists; offer every pairing then.
            if (!list.length) {
                const years = (data.years ?? []).map(Number).filter((y) => y >= 2011 && y <= 2014);
                list = [];
                (data.crops ?? []).forEach((crop) =>
                    (data.districts ?? []).forEach((district) =>
                        (data.seasons ?? []).forEach((season) =>
                            years.forEach((year) => list.push({ crop, district, season, year: String(year) }))
                        )
                    )
                );
            }
            setCombos(list);
            setOptionsStatus("ready");
        } catch (err) {
            setOptionsStatus("error");
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        loadOptions();
    }, [loadOptions]);

    // Only the values that still make a valid combination are offered.
    const choices = useMemo(() => {
        const result = {};
        FIELDS.forEach((field) => {
            const fits = combos.filter((c) => FIELDS.every((k) => k === field || !form[k] || c[k] === form[k]));
            result[field] = uniqueSorted(
                fits.map((c) => c[field]),
                field === "year"
            );
        });
        return result;
    }, [combos, form]);

    function change(field, value) {
        const exists = (f) => combos.some((c) => FIELDS.every((k) => !f[k] || c[k] === f[k]));
        let next = { ...form, [field]: value };
        if (!exists(next)) {
            // Drop the other choices, last first, until a valid combination remains.
            for (const k of [...FIELDS].reverse().filter((k) => k !== field)) {
                next = { ...next, [k]: "" };
                if (exists(next)) break;
            }
        }
        setForm(next);
        setResult(null);
        setRecorded(null);
        setError("");
    }

    const complete = FIELDS.every((field) => form[field]);

    /* ----- estimate ----- */

    async function submit(event) {
        event.preventDefault();
        if (!complete || loading) return;
        setLoading(true);
        setError("");
        setResult(null);
        setRecorded(null);

        try {
            const data = await request("/predict", {
                method: "POST",
                body: { ...form, year: Number(form.year) },
            });
            setResult({
                crop: data.crop ?? form.crop,
                district: data.district ?? form.district,
                season: data.season ?? form.season,
                year: Number(data.year ?? form.year),
                estimate: Number(data.predicted_yield_kg_ha),
            });

            // The recorded yield for that year, when the records have it.
            try {
                const params = new URLSearchParams({
                    crop: form.crop,
                    district: form.district,
                    season: form.season,
                    year: form.year,
                });
                const actual = await request(`/evaluation?${params}`);
                if (Number.isFinite(Number(actual?.actual_yield_kg_ha))) {
                    setRecorded(Number(actual.actual_yield_kg_ha));
                }
            } catch {
                setRecorded(null);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    const accuracy = useMemo(() => {
        if (!result || recorded === null || recorded <= 0) return null;
        const percent = ((result.estimate - recorded) / recorded) * 100;
        const size = Math.abs(percent);
        return {
            percent,
            label: size < 5 ? "Very close" : size < 15 ? "Fairly close" : "A rough guide",
            tone: size < 5 ? "good" : size < 15 ? "fair" : "weak",
        };
    }, [result, recorded]);

    // What the assistant is told about the page, so "this result" makes sense.
    const pageContext = useMemo(() => {
        if (!result) return null;
        const parts = [
            `Yield estimate page. Crop: ${result.crop}. District: ${displayDistrict(result.district)}.`,
            `Season: ${result.season}. Year: ${result.year}.`,
            `Estimated yield: ${number(result.estimate, 0)} kg per hectare.`,
            "This is an estimate for a past year made after the fact, not a forecast for a future season.",
        ];
        if (recorded !== null) parts.push(`Recorded yield for that year: ${number(recorded, 0)} kg per hectare.`);
        return parts.join(" ");
    }, [result, recorded]);

    /* ----- chat ----- */

    useEffect(() => {
        try {
            sessionStorage.setItem(
                CHAT_STORAGE_KEY,
                JSON.stringify(messages.slice(-CHAT_STORED_MESSAGES))
            );
        } catch {
            // Storage can be full or disabled; the chat still works.
        }
    }, [messages]);

    useEffect(() => {
        const log = logRef.current;
        if (log) log.scrollTop = log.scrollHeight;
    }, [messages, pending]);

    useEffect(() => {
        const box = inputRef.current;
        if (!box) return;
        box.style.height = "auto";
        box.style.height = `${Math.min(box.scrollHeight, 130)}px`;
    }, [input]);

    useEffect(
        () => () => {
            window.speechSynthesis?.cancel();
            recognitionRef.current?.stop();
        },
        []
    );

    async function send(text) {
        const question = String(text ?? "").trim();
        if (!question || pending) return;

        const history = messages
            .filter((m) => !m.error && m.content)
            .slice(-CHAT_HISTORY_TURNS)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

        setMessages((previous) => [...previous, { id: newId(), role: "user", content: question }]);
        setInput("");
        setPending(true);

        try {
            const data = await request("/dashboard/chat", {
                method: "POST",
                timeoutMs: 60000,
                body: { question, mode: "chat", language: aiLanguage, history, ...(pageContext ? { page_context: pageContext } : {}) },
            });
            setMessages((previous) => [...previous, { id: newId(), role: "assistant", content: data.answer, language: aiLanguage }]);
        } catch (err) {
            setMessages((previous) => [
                ...previous,
                { id: newId(), role: "assistant", content: err.message, error: true, retry: question },
            ]);
        } finally {
            setPending(false);
        }
    }

    function retry(message) {
        setMessages((previous) => {
            const next = previous.filter((m) => m.id !== message.id);
            if (next[next.length - 1]?.role === "user") next.pop();
            return next;
        });
        send(message.retry);
    }

    function onKeyDown(event) {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send(input);
        }
    }

    function toggleSpeaking(message) {
        const synth = window.speechSynthesis;
        if (!synth) return;
        if (speakingId === message.id) {
            synth.cancel();
            setSpeakingId(null);
            return;
        }
        synth.cancel();
        const utterance = new SpeechSynthesisUtterance(speakable(message.content));
        utterance.lang = "en-IN";
        utterance.onend = () => setSpeakingId(null);
        utterance.onerror = () => setSpeakingId(null);
        setSpeakingId(message.id);
        synth.speak(utterance);
    }

    function toggleListening() {
        if (!SpeechRecognition) return;
        if (listening) {
            recognitionRef.current?.stop();
            return;
        }
        const recognition = new SpeechRecognition();
        recognition.lang = "en-IN";
        recognition.interimResults = false;
        recognition.onresult = (event) => {
            const heard = event.results?.[0]?.[0]?.transcript ?? "";
            if (heard) setInput((current) => (current ? `${current} ${heard}` : heard));
        };
        recognition.onend = () => setListening(false);
        recognition.onerror = () => setListening(false);
        recognitionRef.current = recognition;
        setListening(true);
        recognition.start();
    }

    const starters = useMemo(() => {
        const list = ["What does yield per hectare mean?"];
        list.push(form.crop ? `What affects ${form.crop.toLowerCase()} yield?` : "What affects crop yield?");
        list.push("How can I improve soil health?");
        return list;
    }, [form.crop]);

    /* ----- render ----- */

    const loadingOptions = optionsStatus === "loading";

    return (
        <div className="yp-page">
            <section className="yp-hero">
                <div className="yp-hero-text">
                    <span className="yp-kicker">Crop intelligence</span>
                    <h1>Estimate your crop yield</h1>
                    <p>
                        Choose a crop, district, season and year to see the estimated yield and how it compares with
                        what was recorded. Then ask AgriScope AI anything about it.
                    </p>
                </div>
                <div className="yp-hero-art" aria-hidden="true">
                    <Icon name="sprout" size={64} />
                </div>
            </section>

            <div className="yp-grid">
                <div className="yp-left">
                    <section className="yp-card" aria-labelledby="yp-form-title">
                        <header className="yp-card-head">
                            <span className="yp-step" aria-hidden="true">
                                1
                            </span>
                            <div>
                                <h2 id="yp-form-title">What would you like to estimate?</h2>
                                <p>Estimates cover the past years 2011 to 2014. They are not forecasts for future seasons.</p>
                            </div>
                        </header>

                        <form onSubmit={submit} className="yp-form">
                            <div className="yp-fields">
                                {FIELDS.map((field) => (
                                    <label className="yp-field" key={field}>
                                        <span>{field === "year" ? "Year" : titleCase(field)}</span>
                                        <select
                                            value={form[field]}
                                            onChange={(event) => change(field, event.target.value)}
                                            disabled={loadingOptions || optionsStatus === "error"}
                                        >
                                            <option value="" disabled>
                                                {loadingOptions ? "Loading" : `Select a ${FIELD_LABELS[field]}`}
                                            </option>
                                            {choices[field].map((value) => (
                                                <option key={value} value={value}>
                                                    {field === "district" ? displayDistrict(value) : value}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                ))}
                            </div>

                            <button type="submit" className="yp-primary" disabled={!complete || loading}>
                                {loading ? (
                                    <>
                                        <span className="yp-spinner" aria-hidden="true" /> Working it out
                                    </>
                                ) : (
                                    <>
                                        Show estimate <Icon name="arrow" size={16} />
                                    </>
                                )}
                            </button>
                            {!complete && !loadingOptions && optionsStatus !== "error" && (
                                <p className="yp-hint">Select all four to continue.</p>
                            )}
                        </form>

                        {optionsStatus === "error" && (
                            <div className="yp-alert" role="alert">
                                <p>{error || "We could not load the options."}</p>
                                <button type="button" className="yp-link-button" onClick={loadOptions}>
                                    Try again
                                </button>
                            </div>
                        )}
                        {error && optionsStatus === "ready" && (
                            <div className="yp-alert" role="alert">
                                <p>{error}</p>
                            </div>
                        )}
                    </section>

                    <section className="yp-card yp-result-card" aria-labelledby="yp-result-title" aria-live="polite">
                        <header className="yp-card-head">
                            <span className="yp-step" aria-hidden="true">
                                2
                            </span>
                            <div>
                                <h2 id="yp-result-title">Your estimate</h2>
                                <p>{result ? "Based on the choices above." : "It will appear here once you click Show estimate."}</p>
                            </div>
                        </header>

                        {result ? (
                            <div className="yp-result">
                                <div className="yp-big">
                                    <span className="yp-big-number">{number(result.estimate, 0)}</span>
                                    <span className="yp-big-unit">kg per hectare</span>
                                </div>
                                <div className="yp-chips">
                                    <span>{result.crop}</span>
                                    <span>{displayDistrict(result.district)}</span>
                                    <span>{result.season}</span>
                                    <span>{result.year}</span>
                                </div>

                                {recorded !== null && accuracy && (
                                    <div className="yp-compare">
                                        <h3>How close was it?</h3>
                                        {[
                                            { label: "Estimate", value: result.estimate, tone: "estimate" },
                                            { label: "Recorded", value: recorded, tone: "recorded" },
                                        ].map((row) => (
                                            <div className="yp-bar-row" key={row.label}>
                                                <span className="yp-bar-label">{row.label}</span>
                                                <span className="yp-bar-track">
                                                    <i
                                                        className={`yp-bar yp-bar-${row.tone}`}
                                                        style={{
                                                            width: `${(row.value / Math.max(result.estimate, recorded)) * 100}%`,
                                                        }}
                                                    />
                                                </span>
                                                <span className="yp-bar-value">{number(row.value, 0)}</span>
                                            </div>
                                        ))}
                                        <p className={`yp-verdict yp-verdict-${accuracy.tone}`}>
                                            <strong>{accuracy.label}.</strong> The estimate is{" "}
                                            {number(Math.abs(accuracy.percent), 1)}%{" "}
                                            {accuracy.percent >= 0 ? "above" : "below"} the recorded yield.
                                        </p>
                                    </div>
                                )}

                                <div className="yp-actions">
                                    <button type="button" className="yp-secondary" onClick={() => send("Explain this result in simple words.")} disabled={pending}>
                                        <Icon name="spark" size={16} /> Explain this result
                                    </button>
                                    <Link className="yp-secondary" to="/dashboard">
                                        <Icon name="chart" size={16} /> Compare districts
                                    </Link>
                                </div>
                            </div>
                        ) : (
                            <div className="yp-empty">
                                <Icon name="sprout" size={28} />
                                <p>Choose a crop, district, season and year, then click Show estimate.</p>
                            </div>
                        )}
                    </section>
                </div>

                <aside className="yp-chat" aria-labelledby="yp-chat-title">
                    <header className="yp-chat-head">
                        <div>
                            <h2 id="yp-chat-title">AgriScope AI</h2>
                            <p>Ask anything about farming, or about your estimate.</p>
                            <div className="yp-chat-lang">
                                <AiLanguageSwitch value={aiLanguage} onChange={setAiLanguage} disabled={pending} />
                            </div>
                        </div>
                        {messages.length > 0 && (
                            <button
                                type="button"
                                className="yp-ghost"
                                onClick={() => {
                                    window.speechSynthesis?.cancel();
                                    setMessages([]);
                                }}
                                disabled={pending}
                            >
                                New chat
                            </button>
                        )}
                    </header>

                    <div className="yp-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
                        {messages.length === 0 && (
                            <div className="yp-starters">
                                <p>Ask anything, for example:</p>
                                {starters.map((question) => (
                                    <button type="button" key={question} onClick={() => send(question)} disabled={pending}>
                                        {question}
                                    </button>
                                ))}
                                <small>
                                    AgriScope AI cannot see live weather, market prices or advisories. Confirm pest and
                                    treatment advice locally.
                                </small>
                            </div>
                        )}

                        {messages.map((message) => (
                            <div
                                key={message.id}
                                className={`yp-msg yp-msg-${message.role}${message.error ? " yp-msg-error" : ""}`}
                                lang={message.role === "assistant" && message.language === "telugu" ? "te" : undefined}
                            >
                                {message.role === "assistant" && !message.error ? (
                                    <>
                                        <div className="yp-markdown">
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                                        </div>
                                        {window.speechSynthesis && (
                                            <button
                                                type="button"
                                                className="yp-listen"
                                                onClick={() => toggleSpeaking(message)}
                                                aria-pressed={speakingId === message.id}
                                            >
                                                <Icon name="speaker" size={14} />
                                                {speakingId === message.id ? "Stop" : "Listen"}
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <p>{message.content}</p>
                                        {message.error && message.retry && (
                                            <button type="button" className="yp-listen" onClick={() => retry(message)} disabled={pending}>
                                                Try again
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        ))}

                        {pending && (
                            <div className="yp-msg yp-msg-assistant yp-typing">
                                <span className="yp-spinner" aria-hidden="true" /> Thinking
                            </div>
                        )}
                    </div>

                    <div className="yp-composer">
                        <label htmlFor="yp-chat-input" className="yp-sr">
                            Message AgriScope AI
                        </label>
                        <textarea
                            id="yp-chat-input"
                            ref={inputRef}
                            rows={1}
                            value={input}
                            maxLength={2000}
                            placeholder="Ask AgriScope AI anything"
                            onChange={(event) => setInput(event.target.value)}
                            onKeyDown={onKeyDown}
                        />
                        {SpeechRecognition && (
                            <button
                                type="button"
                                className={`yp-icon-button${listening ? " is-on" : ""}`}
                                onClick={toggleListening}
                                aria-pressed={listening}
                                aria-label={listening ? "Stop listening" : "Speak your question"}
                            >
                                <Icon name="mic" />
                            </button>
                        )}
                        <button
                            type="button"
                            className="yp-send"
                            onClick={() => send(input)}
                            disabled={pending || !input.trim()}
                            aria-label="Send"
                        >
                            <Icon name="send" />
                        </button>
                    </div>
                    <p className="yp-composer-hint">Enter sends. Shift+Enter adds a new line.</p>
                </aside>
            </div>

            <section className="yp-explore" aria-labelledby="yp-explore-title">
                <h2 id="yp-explore-title">Explore AgriScope</h2>
                <div className="yp-cards">
                    <Link className="yp-tile" to="/dashboard">
                        <span className="yp-tile-icon">
                            <Icon name="chart" size={22} />
                        </span>
                        <strong>District comparison</strong>
                        <span>Compare two districts, see yearly patterns, and get insights and suggestions.</span>
                        <em>Open the dashboard</em>
                    </Link>
                    <Link className="yp-tile" to="/field-conditions">
                        <span className="yp-tile-icon">
                            <Icon name="layers" size={22} />
                        </span>
                        <strong>Soil characteristics</strong>
                        <span>See rain, yield and soil for a district in one place.</span>
                        <em>Open field conditions</em>
                    </Link>
                    <div className="yp-tile yp-tile-soon">
                        <span className="yp-tile-icon">
                            <Icon name="satellite" size={22} />
                        </span>
                        <strong>Satellite insights</strong>
                        <span>Follow how rice fields change through the season.</span>
                        <em>Coming soon</em>
                    </div>
                </div>
            </section>

            <footer className="yp-footer">
                <span>AGRISCOPE</span>
                <span>Multi-region crop performance analysis</span>
            </footer>
        </div>
    );
}