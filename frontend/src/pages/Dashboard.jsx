import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiLanguageSwitch, useAiLanguage } from "./AiLanguage.jsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    ResponsiveContainer,
    CartesianGrid,
    XAxis,
    YAxis,
    Tooltip,
    AreaChart,
    Area,
    ReferenceLine,
} from "recharts";

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

const API_URL = (import.meta.env?.VITE_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

const SYM = {
    degC: "\u00B0C",
    mj: "MJ/m\u00B2/day",
    kgdm3: "kg/dm\u00B3",
    minus: "\u2212",
    dash: "\u2014",
    ellipsis: "\u2026",
    ndash: "\u2013",
    plusMinus: "\u00B1",
};

const COLOR = {
    a: "#1F4D32",
    aSoft: "#DCE9DE",
    aText: "#1F4D32",
    b: "#B9801E",
    bSoft: "#F4E6C8",
    bText: "#7F5510",
    ink: "#182218",
    muted: "#5F6E62",
    line: "#DDE4D9",
    grid: "#E8EDE5",
    other: "#C3CEC6",
    surface: "#FFFFFF",
    canvas: "#F4F6F1",
};

// Units are verified: in every source row, yield = production x 1000 / area,
// which is kg/ha for production in tonnes and area in hectares.
const METRICS = [
    { key: "yield", column: "Yield_kg_ha", label: "Yield", unit: "kg/ha", axis: "kg per hectare" },
    { key: "production", column: "Production", label: "Production", unit: "t", axis: "tonnes" },
    { key: "area", column: "Area", label: "Cultivated area", unit: "ha", axis: "hectares" },
];

// The comparison supports Kharif and Rabi only. "Whole Year" rows exist in
// the dataset (1999 and 2014) but are not crop seasons.
const ALLOWED_SEASONS = ["kharif", "rabi"];

const CHAT_STORAGE_KEY = "agriscope-dashboard-chat";
// Only the analyzed selection is stored; its data is re-read from the server.
const ANALYSIS_STORAGE_KEY = "agriscope-dashboard-analysis";
const INSIGHTS_STORAGE_KEY = "agriscope-dashboard-insights";
const CHAT_HISTORY_TURNS = 6;
const CHAT_HISTORY_CHARS = 2000;
const CHAT_STORED_MESSAGES = 40;

const STARTER_QUESTIONS = [
    "What is the difference between Kharif and Rabi?",
    "How can I improve soil health?",
    "Which irrigation methods suit rice?",
    "What causes low yield in chilli?",
];

const PENDING_LABELS = {
    chat: "Thinking",
    explain: "Explaining the results",
    insights: "Looking for patterns and suggestions",
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function clean(value) {
    return String(value ?? "").trim();
}

function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function fmt(value, digits = 1) {
    const n = toNumber(value);
    if (n === null) return "Not available";
    return n.toLocaleString("en-IN", {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
    });
}

// Always shows exactly `digits` decimals (7.0, not 7).
function fixed(value, digits) {
    const n = toNumber(value);
    if (n === null) return "Not available";
    return n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtUnit(value, unit, digits = 0) {
    const n = toNumber(value);
    if (n === null) return "Not available";
    return `${fmt(n, digits)}${unit ? ` ${unit}` : ""}`;
}

const compactNumber = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
});

function fmtAxis(value) {
    const n = toNumber(value);
    if (n === null) return "";
    if (Math.abs(n) >= 10000) return compactNumber.format(n);
    return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function fmtSigned(value, digits = 1) {
    const n = toNumber(value);
    if (n === null) return SYM.dash;
    if (n === 0) return "0";
    const sign = n > 0 ? "+" : SYM.minus;
    return `${sign}${fmt(Math.abs(n), digits)}`;
}

function titleCase(text) {
    const s = clean(text);
    if (!s) return "";
    return s
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

function displayDistrict(name) {
    return titleCase(name).replace(/\bSpsr\b/g, "SPSR");
}

function unique(values) {
    return [...new Set(values.map(clean).filter(Boolean))];
}

// Two yields within 1% of each other count as level, not as a win.
const LEVEL_TOLERANCE = 0.01;

function isLevel(a, b) {
    const x = toNumber(a);
    const y = toNumber(b);
    if (x === null || y === null) return false;
    const top = Math.max(Math.abs(x), Math.abs(y));
    return top === 0 || Math.abs(x - y) / top < LEVEL_TOLERANCE;
}

// Districts whose yields are within 0.5% share a rank ("joint 3rd").
function tiedRank(ranking, district) {
    const row = (ranking ?? []).find((r) => r.district === district);
    if (!row) return null;
    const higher = ranking.filter((r) => r.yield > row.yield * 1.005).length;
    const tied = ranking.filter((r) => Math.abs(r.yield - row.yield) <= row.yield * 0.005).length > 1;
    return { rank: higher + 1, tied, yield: row.yield };
}

function compareValues(a, b) {
    const x = toNumber(a);
    const y = toNumber(b);

    if (x === null || y === null) {
        return { difference: null, higher: null, percent: null };
    }

    const difference = x - y;

    if (difference === 0) {
        return { difference, higher: null, percent: null };
    }

    const higher = difference > 0 ? "a" : "b";
    const lower = higher === "a" ? y : x;

    return {
        difference,
        higher,
        percent: lower > 0 ? (Math.abs(difference) / lower) * 100 : null,
    };
}

// [1997, 1998, 1999, 2007] -> "1997–1999, 2007"
function compressYears(years) {
    const sorted = [...years].sort((x, y) => x - y);
    const parts = [];
    let start = null;
    let prev = null;
    for (const year of sorted) {
        if (start === null) {
            start = year;
        } else if (year !== prev + 1) {
            parts.push(start === prev ? `${start}` : `${start}${SYM.ndash}${prev}`);
            start = year;
        }
        prev = year;
    }
    if (start !== null) {
        parts.push(start === prev ? `${start}` : `${start}${SYM.ndash}${prev}`);
    }
    return parts.join(", ");
}

function selectionKey(selection) {
    if (!selection) return "";
    return [
        selection.crop,
        selection.season,
        selection.year,
        selection.district_a,
        selection.district_b,
    ]
        .map((part) => clean(part).toLowerCase())
        .join("|");
}

function selectionFromFilters(filters) {
    return {
        crop: filters.crop,
        season: filters.season,
        year: Number(filters.year),
        district_a: filters.districtA,
        district_b: filters.districtB,
    };
}

function describeSelection(selection) {
    return `${displayDistrict(selection.district_a)} vs ${displayDistrict(
        selection.district_b
    )}, ${selection.crop}, ${selection.season} ${selection.year}`;
}

let messageCounter = 0;
function newId() {
    messageCounter += 1;
    return `${Date.now().toString(36)}-${messageCounter}`;
}

function loadStoredChat() {
    try {
        const stored = JSON.parse(sessionStorage.getItem(CHAT_STORAGE_KEY) || "[]");
        return Array.isArray(stored) ? stored : [];
    } catch {
        return [];
    }
}

function saveStoredChat(messages) {
    try {
        sessionStorage.setItem(
            CHAT_STORAGE_KEY,
            JSON.stringify(messages.slice(-CHAT_STORED_MESSAGES))
        );
    } catch {
        // Storage can be full or disabled; the chat still works in memory.
    }
}

function loadStoredSelection() {
    try {
        const stored = JSON.parse(sessionStorage.getItem(ANALYSIS_STORAGE_KEY) || "null");
        return stored && typeof stored === "object" ? stored : null;
    } catch {
        return null;
    }
}

function saveStoredSelection(selection) {
    try {
        if (selection) sessionStorage.setItem(ANALYSIS_STORAGE_KEY, JSON.stringify(selection));
        else sessionStorage.removeItem(ANALYSIS_STORAGE_KEY);
    } catch {
        // Not critical: the comparison simply is not restored.
    }
}

function loadStoredInsights() {
    try {
        const stored = JSON.parse(sessionStorage.getItem(INSIGHTS_STORAGE_KEY) || "null");
        return stored && stored.key && stored.data ? stored : null;
    } catch {
        return null;
    }
}

function saveStoredInsights(value) {
    try {
        if (value) sessionStorage.setItem(INSIGHTS_STORAGE_KEY, JSON.stringify(value));
        else sessionStorage.removeItem(INSIGHTS_STORAGE_KEY);
    } catch {
        // Not critical: insights are simply generated again.
    }
}

async function apiRequest(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
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
            throw new Error("The server took too long to respond. Try again.");
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
        const message =
            typeof detail === "string"
                ? detail
                : Array.isArray(detail)
                    ? detail.map((item) => item?.msg).filter(Boolean).join(" ")
                    : "";
        throw new Error(message || `The request failed (status ${response.status}).`);
    }

    return payload;
}

/* -------------------------------------------------------------------------- */
/*  Comparison view model (all arithmetic on real returned values)            */
/* -------------------------------------------------------------------------- */

function buildComparison(data, period) {
    const c = data?.comparison ?? {};
    const nameA = c.district_a;
    const nameB = c.district_b;
    const recordA = data?.records?.[nameA] ?? null;
    const recordB = data?.records?.[nameB] ?? null;

    const metrics = METRICS.map((metric) => {
        const a = toNumber(recordA?.[metric.column]);
        const b = toNumber(recordB?.[metric.column]);
        return { ...metric, a, b, ...compareValues(a, b) };
    });

    const toMap = (items) =>
        new Map(
            (items ?? [])
                .map((p) => [toNumber(p.year), toNumber(p.observed_yield)])
                .filter(([year, value]) => year !== null && value !== null)
        );
    const mapA = toMap(data?.historical_trends?.[nameA]);
    const mapB = toMap(data?.historical_trends?.[nameB]);

    const weatherMaps = (items) => {
        const series = (key) =>
            new Map(
                (items ?? [])
                    .map((p) => [toNumber(p.year), toNumber(p[key])])
                    .filter(([year, value]) => year !== null && value !== null)
            );
        return { rain: series("rainfall_mm"), temp: series("mean_temperature_c"), humid: series("relative_humidity_pct") };
    };
    const weather = {
        a: weatherMaps(data?.historical_trends?.[nameA]),
        b: weatherMaps(data?.historical_trends?.[nameB]),
    };
    const recordedYears = [...mapA.keys(), ...mapB.keys(), c.year].filter(
        (year) => toNumber(year) !== null
    );

    const start = period?.start_year ?? Math.min(...recordedYears);
    const end = period?.end_year ?? Math.max(...recordedYears);

    const trendData = [];
    for (let year = start; year <= end; year += 1) {
        trendData.push({
            year,
            a: mapA.has(year) ? mapA.get(year) : null,
            b: mapB.has(year) ? mapB.get(year) : null,
        });
    }

    return {
        crop: c.crop,
        season: c.season,
        year: c.year,
        nameA,
        nameB,
        labelA: displayDistrict(nameA),
        labelB: displayDistrict(nameB),
        recordA,
        recordB,
        metrics,
        trendData,
        weather,
        hasTrend: mapA.size > 0 || mapB.size > 0,
        quality: data?.data_quality ?? {},
    };
}

/* Every part of the report has the same shape: a heading, one visual, and a
   plain-language "What this means" note. The notes are written here from the
   real returned values, so they work even when the AI is unavailable. */

function ordinal(n) {
    const suffix = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return `${n}${suffix[(v - 20) % 10] || suffix[v] || suffix[0]}`;
}

// How often each district led, over the years that both have a record.
function yearsAhead(view) {
    const both = view.trendData.filter((p) => p.a !== null && p.b !== null);
    let winsA = 0;
    let winsB = 0;
    let level = 0;
    let changes = 0;
    let previous = 0;
    both.forEach((p) => {
        if (isLevel(p.a, p.b)) {
            level += 1;
            return;
        }
        const sign = Math.sign(p.a - p.b);
        if (sign > 0) winsA += 1;
        else winsB += 1;
        if (previous !== 0 && sign !== previous) changes += 1;
        previous = sign;
    });
    return {
        total: both.length,
        winsA,
        winsB,
        level,
        changes,
        first: both[0]?.year ?? null,
        last: both[both.length - 1]?.year ?? null,
    };
}

function qualityNotes(view) {
    const notes = [];
    const label = (district) => displayDistrict(district);

    // Several districts reporting the very same yield is a property of the records.
    const sharedNow = view.quality.selected_year_shared ?? {};
    const inGroup = [view.nameA, view.nameB].filter((name) => sharedNow[name]);
    if (inGroup.length) {
        const count = Math.max(...inGroup.map((name) => sharedNow[name].districts_sharing));
        notes.push(
            `In ${view.season} ${view.year}, ${count} districts, including ${inGroup.map(label).join(" and ")}, ` +
            `report almost the same yield (about ${fmt(sharedNow[inGroup[0]].yield, 0)} kg/ha) although they planted very ` +
            `different areas. This looks like one figure shared in the records, so this year may not show which ` +
            `district really did better.`
        );
    }
    const sharedYears = view.quality.shared_figure_years ?? {};
    const heavy = [
        ["a", view.nameA],
        ["b", view.nameB],
    ]
        .map(([which, name]) => ({
            label: label(name),
            count: (sharedYears[name] ?? []).length,
            total: view.trendData.filter((p) => p[which] !== null).length,
        }))
        .filter((item) => item.total >= 5 && item.count / item.total >= 0.3);
    if (heavy.length) {
        notes.push(
            `${heavy.map((item) => `${item.label} (${item.count} of ${item.total} years)`).join(" and ")} ` +
            `${heavy.length > 1 ? "have" : "has"} yearly yields that match several other districts, so differences ` +
            `between years and districts should be read with care.`
        );
    }

    const status = view.quality.selected_year_status ?? {};
    Object.entries(status).forEach(([district, value]) => {
        if (value === "conflicting_rows_not_used") {
            notes.push(
                `${label(district)} has more than one different record for ${view.year}, so its ${view.year} values are not shown rather than picking one.`
            );
        } else if (value === "identical_duplicates_collapsed") {
            notes.push(`${label(district)} had a repeated identical record for ${view.year}; it is counted once.`);
        }
    });
    const excluded = view.quality.trend_years_excluded_conflicting_rows ?? {};
    Object.entries(excluded).forEach(([district, years]) => {
        if (years?.length) {
            notes.push(
                `Years left out of ${label(district)}'s history because of conflicting records: ${compressYears(years)}.`
            );
        }
    });
    return notes;
}

/* -------------------------------------------------------------------------- */
/*  Icons (inline SVG, no emoji)                                              */
/* -------------------------------------------------------------------------- */

function Icon({ name, size = 18 }) {
    const common = {
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
        case "sparkle":
            return (
                <svg {...common}>
                    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
                    <path d="M12 7l1.8 3.2L17 12l-3.2 1.8L12 17l-1.8-3.2L7 12z" />
                </svg>
            );
        case "alert":
            return (
                <svg {...common}>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v5M12 16h.01" />
                </svg>
            );
        case "chart":
            return (
                <svg {...common}>
                    <path d="M3 3v18h18" />
                    <path d="m7 14 4-4 3 3 6-7" />
                </svg>
            );
        case "explain":
            return (
                <svg {...common}>
                    <path d="M4 5h16v11H8l-4 4z" />
                    <path d="M8 9h8M8 12h5" />
                </svg>
            );
        case "send":
            return (
                <svg {...common}>
                    <path d="m22 2-7 20-4-9-9-4z" />
                    <path d="M22 2 11 13" />
                </svg>
            );
        case "refresh":
            return (
                <svg {...common}>
                    <path d="M20 7v5h-5M4 17v-5h5" />
                    <path d="M5.5 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.5-3" />
                </svg>
            );
        default:
            return (
                <svg {...common}>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v4M12 16h.01" />
                </svg>
            );
    }
}

/* -------------------------------------------------------------------------- */
/*  Shared UI components                                                      */
/* -------------------------------------------------------------------------- */

function Spinner({ label = "Loading" }) {
    return <span className="as-spinner" role="status" aria-label={label} />;
}

function Alert({ tone = "error", title, children, action }) {
    return (
        <div className={`as-alert as-alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
            <div className="as-alert-icon">
                <Icon name="alert" size={18} />
            </div>
            <div className="as-alert-content">
                {title && <strong>{title}</strong>}
                <div>{children}</div>
                {action && <div className="as-alert-action">{action}</div>}
            </div>
        </div>
    );
}

function EmptyState({ title, detail }) {
    return (
        <div className="as-empty">
            <Icon name="chart" size={24} />
            <strong>{title}</strong>
            {detail && <p>{detail}</p>}
        </div>
    );
}

function DistrictName({ which, children }) {
    return <span className={`as-name as-name-${which}`}>{children}</span>;
}

function ChartTooltip({ active, payload, label, unit = "", digits = 0 }) {
    if (!active || !payload?.length) return null;

    return (
        <div className="as-tooltip">
            <strong>{label}</strong>
            {payload.map((item, index) => (
                <div className="as-tooltip-row" key={`${item.dataKey}-${index}`}>
                    <span
                        className="as-tooltip-dot"
                        style={{ background: item.color || item.payload?.fill || item.fill }}
                    />
                    <span>{item.name || item.payload?.name || item.dataKey}</span>
                    <b>
                        {item.value === null || item.value === undefined
                            ? "No record"
                            : `${fmt(item.value, digits)}${unit ? ` ${unit}` : ""}`}
                    </b>
                </div>
            ))}
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/*  Calculations for the report (all from real returned values)               */
/* -------------------------------------------------------------------------- */

function initials(name) {
    const words = clean(name).split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return clean(name).slice(0, 2).toUpperCase();
}

// Same formula as the backend (sample standard deviation), so the numbers agree.
function seriesStats(trendData, key) {
    const points = trendData.filter((p) => p[key] !== null).map((p) => ({ year: p.year, value: p[key] }));
    if (points.length < 3) return null;
    const values = points.map((p) => p.value);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    const low = points.reduce((best, p) => (p.value < best.value ? p : best));
    const high = points.reduce((best, p) => (p.value > best.value ? p : best));
    return {
        count: points.length,
        mean,
        min: low.value,
        minYear: low.year,
        max: high.value,
        maxYear: high.year,
        swing: mean > 0 ? (Math.sqrt(variance) / mean) * 100 : null,
        // A "bad year" is a yield at least 10% below the district's own average.
        badYears: new Set(points.filter((p) => p.value < 0.9 * mean).map((p) => p.year)),
    };
}

// Least-squares trend in kg/ha per year (needs six or more recorded years).
function slopePerYear(trendData, key) {
    const points = trendData.filter((p) => p[key] !== null).map((p) => [p.year, p[key]]);
    if (points.length < 6) return null;
    const n = points.length;
    const mx = points.reduce((s, p) => s + p[0], 0) / n;
    const my = points.reduce((s, p) => s + p[1], 0) / n;
    const sxx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    if (sxx === 0) return null;
    return points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx;
}

function overviewMatches(view, overview) {
    return Boolean(
        view &&
        overview?.selection &&
        clean(overview.selection.crop).toLowerCase() === clean(view.crop).toLowerCase() &&
        clean(overview.selection.season).toLowerCase() === clean(view.season).toLowerCase() &&
        Number(overview.selection.year) === Number(view.year)
    );
}

function rankInfoFor(view, overview) {
    if (!overviewMatches(view, overview) || !overview.ranking?.length) return null;
    return {
        a: tiedRank(overview.ranking, view.nameA),
        b: tiedRank(overview.ranking, view.nameB),
        total: overview.ranking.length,
    };
}

// Six summary tiles: the selected year first, then the long-run picture.
function buildKpis(view, rankInfo) {
    const [yieldM] = view.metrics;
    const name = (which) => (which === "a" ? view.labelA : view.labelB);
    const rankText = (entry) =>
        entry ? `${entry.tied ? "joint " : ""}${ordinal(entry.rank)} of ${rankInfo.total} districts` : null;
    const level = isLevel(yieldM.a, yieldM.b);
    const tiles = [];

    if (view.recordA || view.recordB) {
        tiles.push(
            {
                key: "ya",
                tone: "a",
                label: `${view.labelA} yield`,
                value: yieldM.a === null ? SYM.dash : fmt(yieldM.a, 0),
                unit: yieldM.a === null ? "" : "kg/ha",
                sub: rankText(rankInfo?.a) ?? (yieldM.a === null ? "No record" : `${view.season} ${view.year}`),
            },
            {
                key: "yb",
                tone: "b",
                label: `${view.labelB} yield`,
                value: yieldM.b === null ? SYM.dash : fmt(yieldM.b, 0),
                unit: yieldM.b === null ? "" : "kg/ha",
                sub: rankText(rankInfo?.b) ?? (yieldM.b === null ? "No record" : `${view.season} ${view.year}`),
            },
            {
                key: "gap",
                tone: level ? "n" : (yieldM.higher ?? "n"),
                label: "Yield gap",
                value: yieldM.difference === null ? SYM.dash : level ? "Level" : fmt(Math.abs(yieldM.difference), 0),
                unit: yieldM.difference === null || level ? "" : "kg/ha",
                sub: level
                    ? "Less than 1% apart"
                    : yieldM.higher
                        ? `${name(yieldM.higher)} ${yieldM.percent !== null ? `${fmt(yieldM.percent, 1)}% ` : ""}higher`
                        : "Not available",
            }
        );
    }

    if (view.hasTrend) {
        const sa = seriesStats(view.trendData, "a");
        const sb = seriesStats(view.trendData, "b");
        const ta = slopePerYear(view.trendData, "a");
        const tb = slopePerYear(view.trendData, "b");
        const row = (which, value, unit) => ({ which, name: name(which), value, unit });

        // Average yield over every recorded year
        const avgLevel = isLevel(sa?.mean, sb?.mean);
        const avg = compareValues(sa?.mean ?? null, sb?.mean ?? null);
        tiles.push({
            key: "avg",
            kind: "dual",
            label: "Average yield, all years",
            lead: avgLevel ? null : avg.higher,
            rows: [
                row("a", sa ? fmt(sa.mean, 0) : "n/a", sa ? "kg/ha" : ""),
                row("b", sb ? fmt(sb.mean, 0) : "n/a", sb ? "kg/ha" : ""),
            ],
            sub: avgLevel
                ? "About the same over the years"
                : avg.higher
                    ? `${name(avg.higher)} ${avg.percent !== null ? `${fmt(avg.percent, 1)}% ` : ""}higher over the years`
                    : "Not enough years to compare",
        });

        // Which district is improving faster
        const trend = compareValues(ta, tb);
        const trendLevel = ta !== null && tb !== null && Math.abs(ta - tb) < 5;
        let trendSub = "Needs six or more recorded years";
        if (ta !== null && tb !== null) {
            if (trendLevel) trendSub = "Both changing at about the same pace";
            else if (ta > 0 && tb > 0) trendSub = `Both improving, ${name(trend.higher ?? "a")} faster`;
            else if (ta <= 0 && tb <= 0) trendSub = `Both flat or falling, ${name(trend.higher ?? "a")} better`;
            else trendSub = `${name(ta > 0 ? "a" : "b")} improving, ${name(ta > 0 ? "b" : "a")} not`;
        }
        tiles.push({
            key: "trend",
            kind: "dual",
            label: "Yield trend per year",
            lead: trendLevel ? null : trend.higher,
            rows: [
                row("a", ta === null ? "n/a" : fmtSigned(ta, 0), ta === null ? "" : "kg/ha a year"),
                row("b", tb === null ? "n/a" : fmtSigned(tb, 0), tb === null ? "" : "kg/ha a year"),
            ],
            sub: trendSub,
        });

        // Lowest to highest yield: how far the results can swing
        tiles.push({
            key: "range",
            kind: "dual",
            stack: true,
            label: "Lowest to highest yield",
            lead: null,
            rows: [
                row("a", sa ? `${fmt(sa.min, 0)}${SYM.ndash}${fmt(sa.max, 0)}` : "n/a", sa ? "kg/ha" : ""),
                row("b", sb ? `${fmt(sb.min, 0)}${SYM.ndash}${fmt(sb.max, 0)}` : "n/a", sb ? "kg/ha" : ""),
            ],
            sub: "Worst year to best year on record",
        });
    }
    return tiles;
}

// The shared years in two five-year windows: how the gap has changed.
function gapWindows(view) {
    const both = view.trendData.filter((p) => p.a !== null && p.b !== null);
    if (both.length < 10) return null;
    const windowOf = (items) => {
        const mean = (key) => items.reduce((sum, p) => sum + p[key], 0) / items.length;
        return {
            years: `${items[0].year}${SYM.ndash}${items[items.length - 1].year}`,
            diff: mean("a") - mean("b"),
            level: (mean("a") + mean("b")) / 2,
        };
    };
    return { first: windowOf(both.slice(0, 5)), last: windowOf(both.slice(-5)) };
}

function gapSentence(view, windows) {
    if (!windows) return null;
    const say = (w) =>
        Math.abs(w.diff) < LEVEL_TOLERANCE * w.level
            ? "the two were level"
            : `${w.diff > 0 ? view.labelA : view.labelB} led by ${fmt(Math.abs(w.diff), 0)} kg/ha`;
    return `Early years (${windows.first.years}): ${say(windows.first)}. Recent years (${windows.last.years}): ${say(windows.last)}.`;
}

// The district with the higher yield in the selected year, or null when level.
function yieldLead(view) {
    const [yieldM] = view.metrics;
    return isLevel(yieldM.a, yieldM.b) ? null : yieldM.higher;
}

function takeawayTrend(view, ahead) {
    const name = (which) => (which === "a" ? view.labelA : view.labelB);
    if (ahead.total < 3) {
        return "Fewer than three years have records for both districts, so a long-term pattern cannot be judged.";
    }
    if (ahead.level >= ahead.total * 0.6) {
        return `In ${ahead.level} of ${ahead.total} years the two districts had practically the same yield.`;
    }
    const levelNote = ahead.level ? ` (level in ${ahead.level})` : "";
    if (ahead.winsA === ahead.winsB) {
        return `Each district had the higher yield in ${ahead.winsA} of ${ahead.total} years${levelNote}.`;
    }
    const leader = ahead.winsA > ahead.winsB ? "a" : "b";
    let text = `${name(leader)} had the higher yield in ${Math.max(ahead.winsA, ahead.winsB)} of ${ahead.total} years${levelNote}`;
    const selectedLead = yieldLead(view);
    if (selectedLead) {
        text += selectedLead === leader ? `, so ${view.year} is typical.` : `, so ${view.year} was an exception.`;
    } else {
        text += ".";
    }
    return text;
}

function takeawayRank(view, overview) {
    const rows = overview.ranking ?? [];
    const mean = toNumber(overview.headline?.mean_yield);
    const describe = (key, label) => {
        const info = tiedRank(rows, key);
        if (!info) return `${label} has no record for ${view.year}`;
        let text = `${label} ranked ${info.tied ? "joint " : ""}${ordinal(info.rank)} of ${rows.length}`;
        if (mean) {
            const percent = ((info.yield - mean) / mean) * 100;
            text += ` (${fmt(Math.abs(percent), 0)}% ${percent >= 0 ? "above" : "below"} average)`;
        }
        return text;
    };
    return `${describe(view.nameA, view.labelA)}. ${describe(view.nameB, view.labelB)}.`;
}

// The selected year's weather against the district's own average (same crop and season).
function conditionOf(view, which, key, mode) {
    const series = view.weather?.[which]?.[key];
    if (!series) return null;
    const value = series.get(view.year) ?? null;
    const values = [...series.values()];
    if (value === null) return null;
    const usual = values.length >= 5 ? values.reduce((s, v) => s + v, 0) / values.length : null;
    let delta = null;
    if (usual !== null) delta = mode === "percent" ? (usual > 0 ? ((value - usual) / usual) * 100 : null) : value - usual;
    return { value, usual, delta };
}

function deltaText(delta, mode, unit) {
    if (delta === null) return "No usual to compare";
    const tiny = mode === "percent" ? 3 : mode === "temp" ? 0.3 : 1.5;
    if (Math.abs(delta) < tiny) return "About usual";
    const amount =
        mode === "percent" ? `${fmt(Math.abs(delta), 0)}%` : `${fmt(Math.abs(delta), mode === "temp" ? 1 : 0)} ${unit}`;
    return `${amount} ${delta > 0 ? "above" : "below"} usual`;
}

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                           */
/* -------------------------------------------------------------------------- */

function SectionHead({ n, title, subtitle, action, id }) {
    return (
        <div className="as-sh">
            <span className="as-sh-n" aria-hidden="true">
                {n}
            </span>
            <div className="as-sh-text">
                <h2 id={id}>{title}</h2>
                {subtitle && <p>{subtitle}</p>}
            </div>
            {action && <div className="as-sh-action">{action}</div>}
        </div>
    );
}

function Card({ title, right, takeaway, children, className = "" }) {
    return (
        <article className={`as-card ${className}`}>
            {(title || right) && (
                <header className="as-card-head">
                    {title && <h3>{title}</h3>}
                    {right}
                </header>
            )}
            {children}
            {takeaway && <p className="as-take">{takeaway}</p>}
        </article>
    );
}

function Kpi({ tone = "n", kind, label, value, unit, sub, rows, lead, stack = false }) {
    if (kind === "dual") {
        return (
            <div className={`as-kpi as-kpi-dual${lead ? ` has-lead lead-${lead}` : ""}${stack ? " as-dual-stack" : ""}`}>
                <span className="as-kpi-label">{label}</span>
                <div className="as-dual">
                    {rows.map((row) => (
                        <div className={`as-dual-row as-dual-${row.which}${lead === row.which ? " is-lead" : ""}`} key={row.which}>
                            <span className="as-dual-name">
                                <i className={`as-dot as-dot-${row.which}`} aria-hidden="true" />
                                {row.name}
                            </span>
                            <span className="as-dual-val">
                                <b>{row.value}</b>
                                {row.unit && <small>{row.unit}</small>}
                            </span>
                        </div>
                    ))}
                </div>
                {sub && <span className="as-kpi-sub">{sub}</span>}
            </div>
        );
    }
    return (
        <div className={`as-kpi as-kpi-${tone}`}>
            <span className="as-kpi-label">{label}</span>
            <strong className="as-kpi-value">
                {value}
                {unit && <small>{unit}</small>}
            </strong>
            {sub && <span className="as-kpi-sub">{sub}</span>}
        </div>
    );
}

function Legend2({ labelA, labelB }) {
    return (
        <span className="as-legend">
            <span>
                <i className="as-dot as-dot-a" aria-hidden="true" />
                {labelA}
            </span>
            <span>
                <i className="as-dot as-dot-b" aria-hidden="true" />
                {labelB}
            </span>
        </span>
    );
}

/* -------------------------------------------------------------------------- */
/*  Charts                                                                    */
/* -------------------------------------------------------------------------- */

function YieldTrend({ view }) {
    const { trendData, labelA, labelB, year } = view;
    const missingA = trendData.filter((p) => p.a === null).map((p) => p.year);
    const missingB = trendData.filter((p) => p.b === null).map((p) => p.year);

    return (
        <div className="as-fill">
            <div className="as-chart-box">
                <ResponsiveContainer width="100%" height="100%" minHeight={250}>
                    <AreaChart data={trendData} margin={{ top: 18, right: 14, bottom: 0, left: 0 }}>
                        <defs>
                            <linearGradient id="as-grad-a" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={COLOR.a} stopOpacity={0.22} />
                                <stop offset="100%" stopColor={COLOR.a} stopOpacity={0.02} />
                            </linearGradient>
                            <linearGradient id="as-grad-b" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={COLOR.b} stopOpacity={0.22} />
                                <stop offset="100%" stopColor={COLOR.b} stopOpacity={0.02} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 4" vertical={false} />
                        <XAxis
                            dataKey="year"
                            tick={{ fontSize: 11, fill: COLOR.muted }}
                            axisLine={{ stroke: COLOR.line }}
                            tickLine={false}
                            interval="preserveStartEnd"
                            minTickGap={12}
                        />
                        <YAxis
                            tickFormatter={fmtAxis}
                            tick={{ fontSize: 11, fill: COLOR.muted }}
                            axisLine={false}
                            tickLine={false}
                            width={48}
                            domain={["auto", "auto"]}
                        />
                        <Tooltip content={<ChartTooltip unit="kg/ha" />} />
                        <ReferenceLine
                            x={year}
                            stroke={COLOR.muted}
                            strokeDasharray="4 4"
                            label={{ value: String(year), position: "top", fill: COLOR.muted, fontSize: 11 }}
                        />
                        <Area
                            type="linear"
                            dataKey="a"
                            name={labelA}
                            stroke={COLOR.a}
                            strokeWidth={2.4}
                            fill="url(#as-grad-a)"
                            dot={{ r: 2.5, strokeWidth: 0, fill: COLOR.a }}
                            activeDot={{ r: 5 }}
                            connectNulls={false}
                            isAnimationActive={false}
                        />
                        <Area
                            type="linear"
                            dataKey="b"
                            name={labelB}
                            stroke={COLOR.b}
                            strokeWidth={2.4}
                            fill="url(#as-grad-b)"
                            dot={{ r: 2.5, strokeWidth: 0, fill: COLOR.b }}
                            activeDot={{ r: 5 }}
                            connectNulls={false}
                            isAnimationActive={false}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
            {(missingA.length > 0 || missingB.length > 0) && (
                <p className="as-footnote">
                    No record for{" "}
                    {missingA.join() === missingB.join()
                        ? `either district in ${compressYears(missingA)}`
                        : [
                            missingA.length && `${labelA} in ${compressYears(missingA)}`,
                            missingB.length && `${labelB} in ${compressYears(missingB)}`,
                        ]
                            .filter(Boolean)
                            .join(", or for ")}
                    . Gaps in the lines are years without a record.
                </p>
            )}
        </div>
    );
}


function RankingBars({ ranking, mean, nameA, nameB }) {
    if (!ranking?.length) {
        return <p className="as-small as-muted">No district has a yield record for this year.</p>;
    }
    const max = Math.max(...ranking.map((r) => r.yield));
    const avgLeft = mean && max > 0 ? Math.min((mean / max) * 100, 100) : null;

    return (
        <div className="as-rank" role="list" aria-label="Districts ranked by yield in kg per hectare">
            {ranking.map((row) => {
                const side = row.district === nameA ? "a" : row.district === nameB ? "b" : null;
                const info = tiedRank(ranking, row.district);
                return (
                    <div className={`as-rk${side ? ` as-rk-${side}` : ""}`} role="listitem" key={row.district}>
                        <span className="as-rk-n">{info.rank}</span>
                        <span className="as-rk-name">{displayDistrict(row.district)}</span>
                        <span className="as-rk-track">
                            <i style={{ width: `${Math.max((row.yield / max) * 100, 2)}%` }} />
                            {avgLeft !== null && <b className="as-rk-avg" style={{ left: `${avgLeft}%` }} />}
                        </span>
                        <span className="as-rk-val">{fmt(row.yield, 0)}</span>
                    </div>
                );
            })}
            {mean !== null && (
                <p className="as-footnote as-rk-note">
                    <span className="as-rk-key" aria-hidden="true" /> Dashed line: average of districts ({fmt(mean, 0)} kg/ha).
                    Values in kg/ha. Districts with almost the same yield share a number.
                </p>
            )}
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/*  Comparison: four panels, each showing something the dashboard does not    */
/* -------------------------------------------------------------------------- */

function Panel({ title, answer, hint, takeaway, children, className = "" }) {
    return (
        <article className={`as-card as-panel ${className}`}>
            <header className="as-pn-head">
                <h3>{title}</h3>
                {hint && <p>{hint}</p>}
            </header>
            {answer && <p className="as-answer">{answer}</p>}
            {children}
            {takeaway && <p className="as-take">{takeaway}</p>}
        </article>
    );
}

function VersusBar({ view }) {
    return (
        <header className="as-card as-vs-bar">
            <div className="as-vs-team">
                <span className="as-avatar as-avatar-a">{initials(view.labelA)}</span>
                <span>
                    <strong>{view.labelA}</strong>
                    <small>District A</small>
                </span>
            </div>
            <span className="as-vs-badge">vs</span>
            <div className="as-vs-team as-vs-team-b">
                <span>
                    <strong>{view.labelB}</strong>
                    <small>District B</small>
                </span>
                <span className="as-avatar as-avatar-b">{initials(view.labelB)}</span>
            </div>
        </header>
    );
}

function LeadPanel({ view, ahead }) {
    const { trendData, labelA, labelB, year } = view;
    const windows = gapWindows(view);

    if (ahead.total < 3) {
        return (
            <Panel title="Which district was ahead more often?">
                <p className="as-small as-muted">Fewer than three years have records for both districts.</p>
            </Panel>
        );
    }

    const cellOf = (p) => {
        if (p.a === null || p.b === null) return "none";
        if (isLevel(p.a, p.b)) return "tie";
        return p.a > p.b ? "a" : "b";
    };
    const describe = (p) =>
        p.a === null || p.b === null
            ? `${p.year}: no record for ${p.a === null && p.b === null ? "either district" : p.a === null ? labelA : labelB}`
            : `${p.year}: ${labelA} ${fmt(p.a, 0)} vs ${labelB} ${fmt(p.b, 0)} kg/ha`;

    let answer;
    if (ahead.level >= ahead.total * 0.6) {
        answer = `Mostly level: the two had practically the same yield in ${ahead.level} of ${ahead.total} years.`;
    } else if (ahead.winsA === ahead.winsB) {
        answer = `Neither: ${labelA} and ${labelB} were each ahead in ${ahead.winsA} of ${ahead.total} years.`;
    } else {
        const leader = ahead.winsA > ahead.winsB ? labelA : labelB;
        answer = `${leader} was ahead in ${Math.max(ahead.winsA, ahead.winsB)} of ${ahead.total} years.`;
    }

    return (
        <Panel
            title="Which district was ahead more often?"
            answer={answer}
            hint="One square per year. The colour shows which district had the higher yield; grey means the two were within 1%."
            takeaway={gapSentence(view, windows)}
        >
            <div className="as-lead-score">
                <span className="as-lead-a">
                    <b>{ahead.winsA}</b> {labelA}
                </span>
                <span className="as-lead-b">
                    <b>{ahead.winsB}</b> {labelB}
                </span>
                <span className="as-lead-n">
                    <b>{ahead.level}</b> level
                </span>
            </div>

            <div
                className="as-strip"
                style={{ "--n": trendData.length }}
                role="img"
                aria-label={`Higher-yield district in each year: ${labelA} ${ahead.winsA} years, ${labelB} ${ahead.winsB} years, level ${ahead.level} years`}
            >
                {trendData.map((p) => (
                    <span
                        key={p.year}
                        className={`as-strip-cell as-strip-${cellOf(p)}${p.year === year ? " is-sel" : ""}`}
                        title={describe(p)}
                    >
                        <b>{String(p.year).slice(2)}</b>
                    </span>
                ))}
            </div>
            <div className="as-strip-axis">
                <span>{trendData[0]?.year}</span>
                <span>{trendData[trendData.length - 1]?.year}</span>
            </div>
        </Panel>
    );
}

function ShareBar({ title, a, b, unit, labelA, labelB }) {
    const total = a + b;
    const pa = total > 0 ? (a / total) * 100 : 50;
    const pb = 100 - pa;
    return (
        <div className="as-share">
            <div className="as-share-title">{title}</div>
            <div
                className="as-share-bar"
                role="img"
                aria-label={`${title}: ${labelA} ${fmt(pa, 0)}%, ${labelB} ${fmt(pb, 0)}% of the combined total`}
            >
                <i className="as-fill-a" style={{ width: `${pa}%` }}>
                    {pa >= 14 ? `${fmt(pa, 0)}%` : ""}
                </i>
                <i className="as-fill-b" style={{ width: `${pb}%` }}>
                    {pb >= 14 ? `${fmt(pb, 0)}%` : ""}
                </i>
            </div>
            <div className="as-share-vals">
                <span className="as-share-a">
                    <small>{labelA}</small>
                    <span className="as-share-num">
                        <b>{fmt(a, 0)}</b> {unit}
                    </span>
                </span>
                <span className="as-share-b">
                    <small>{labelB}</small>
                    <span className="as-share-num">
                        <b>{fmt(b, 0)}</b> {unit}
                    </span>
                </span>
            </div>
        </div>
    );
}

function ScalePanel({ view }) {
    const [, productionM, areaM] = view.metrics;
    const usable = [productionM.a, productionM.b, areaM.a, areaM.b].every((v) => v !== null && v > 0);

    let answer = null;
    let takeaway = null;
    if (usable) {
        const areaShareA = (areaM.a / (areaM.a + areaM.b)) * 100;
        const prodShareA = (productionM.a / (productionM.a + productionM.b)) * 100;
        const bigIsA = areaShareA >= 50;
        const areaShare = bigIsA ? areaShareA : 100 - areaShareA;
        const prodShare = bigIsA ? prodShareA : 100 - prodShareA;
        const bigName = bigIsA ? view.labelA : view.labelB;
        answer = `${bigName} grows more: ${fmt(areaShare, 0)}% of the land and ${fmt(prodShare, 0)}% of the harvest, out of the two districts together.`;
        takeaway =
            prodShare > areaShare + 0.5
                ? `${bigName} gets more harvest from each hectare.`
                : prodShare < areaShare - 0.5
                    ? `${bigName} gets less harvest from each hectare.`
                    : "Both districts get about the same harvest from each hectare.";
    }

    return (
        <Panel
            title="Which district grows more?"
            answer={answer}
            hint={`Harvest and land in ${view.year}, as a share of the two districts together`}
            takeaway={takeaway}
        >
            {usable ? (
                <div className="as-share-list">
                    <ShareBar title="Total harvest (production)" a={productionM.a} b={productionM.b} unit="t" labelA={view.labelA} labelB={view.labelB} />
                    <ShareBar title="Land planted" a={areaM.a} b={areaM.b} unit="ha" labelA={view.labelA} labelB={view.labelB} />
                </div>
            ) : (
                <p className="as-small as-muted">Both districts need a record for {view.year} to compare how much they grow.</p>
            )}
        </Panel>
    );
}

function ReliabilityPanel({ view }) {
    const { trendData, labelA, labelB } = view;
    const sa = seriesStats(trendData, "a");
    const sb = seriesStats(trendData, "b");

    if (!sa || !sb) {
        return (
            <Panel title="Which district is more dependable?">
                <p className="as-small as-muted">Both districts need at least three recorded years.</p>
            </Panel>
        );
    }

    const badA = sa.badYears.size;
    const badB = sb.badYears.size;
    const answer =
        badA === badB
            ? `Both had ${badA} bad ${badA === 1 ? "year" : "years"}, out of ${sa.count} recorded.`
            : `${badA < badB ? labelA : labelB} had fewer bad years: ${Math.min(badA, badB)} against ${Math.max(badA, badB)}.`;
    const rows = [
        { which: "a", label: labelA, stats: sa },
        { which: "b", label: labelB, stats: sb },
    ];

    return (
        <Panel
            title="Which district is more dependable?"
            answer={answer}
            hint="A bad year is a yield at least 10% below that district's own average."
        >
            <div className="as-rel">
                {rows.map(({ which, label, stats }) => (
                    <div className="as-rel-row" key={which}>
                        <div className="as-rel-top">
                            <span className="as-rel-name">
                                <i className={`as-dot as-dot-${which}`} aria-hidden="true" /> {label}
                            </span>
                            <span className="as-rel-stats">
                                <span>
                                    <b>{stats.badYears.size}</b> of {stats.count} bad years
                                </span>
                                <span>usually within {SYM.plusMinus}{fmt(stats.swing, 0)}% of its average</span>
                            </span>
                        </div>
                        <div
                            className="as-rel-dots"
                            style={{ "--n": trendData.length }}
                            role="img"
                            aria-label={`${label}: ${stats.badYears.size} bad years out of ${stats.count}`}
                        >
                            {trendData.map((p) => {
                                const value = p[which];
                                const state = value === null ? "none" : stats.badYears.has(p.year) ? "bad" : "ok";
                                return (
                                    <i
                                        key={p.year}
                                        className={`as-rel-dot as-rel-${state}`}
                                        title={value === null ? `${p.year}: no record` : `${p.year}: ${fmt(value, 0)} kg/ha`}
                                    />
                                );
                            })}
                        </div>
                    </div>
                ))}
                <p className="as-rel-key">
                    <span>
                        <i className="as-rel-dot as-rel-ok" /> normal year
                    </span>
                    <span>
                        <i className="as-rel-dot as-rel-bad" /> bad year
                    </span>
                    <span>
                        <i className="as-rel-dot as-rel-none" /> no record
                    </span>
                    <span className="as-rel-years">
                        {trendData[0]?.year} to {trendData[trendData.length - 1]?.year}, left to right
                    </span>
                </p>
            </div>
        </Panel>
    );
}

const WEATHER_ROWS = [
    { label: "Rainfall in the growing window", key: "rain", unit: "mm", mode: "percent", digits: 0 },
    { label: "Mean temperature", key: "temp", unit: "\u00B0C", mode: "temp", digits: 1 },
    { label: "Relative humidity", key: "humid", unit: "%", mode: "points", digits: 0, deltaUnit: "points" },
];
const SOIL_ROWS = [
    ["Organic carbon", "Soil_Organic_Carbon_g_per_kg_0_5cm", "g/kg", 1],
    ["Clay", "Soil_Clay_pct_0_5cm", "%", 1],
    ["Soil pH", "Soil_Soil_pH_H2O_0_5cm", "", 1],
];

function ConditionsPanel({ view }) {
    const { labelA, labelB, year } = view;
    const weather = WEATHER_ROWS.map((row) => ({
        ...row,
        a: conditionOf(view, "a", row.key, row.mode === "percent" ? "percent" : "diff"),
        b: conditionOf(view, "b", row.key, row.mode === "percent" ? "percent" : "diff"),
    })).filter((row) => row.a || row.b);
    const soil = SOIL_ROWS.map(([label, column, unit, digits]) => ({
        label,
        unit,
        digits,
        a: toNumber(view.recordA?.[column]),
        b: toNumber(view.recordB?.[column]),
    })).filter((row) => row.a !== null || row.b !== null);

    if (!weather.length && !soil.length) return null;

    const rain = weather.find((row) => row.key === "rain");
    const phrase = (c, label) =>
        c && c.delta !== null && Math.abs(c.delta) >= 3
            ? `${fmt(Math.abs(c.delta), 0)}% ${c.delta > 0 ? "above" : "below"} usual for ${label}`
            : c && c.delta !== null
                ? `about usual for ${label}`
                : null;
    const rainParts = rain ? [phrase(rain.a, labelA), phrase(rain.b, labelB)].filter(Boolean) : [];
    const answer = rainParts.length
        ? `Rainfall in ${year} was ${rainParts.join(" and ")}.`
        : `Here is how the ${year} growing season compared with usual.`;
    const takeaway = "Weather and soil show the conditions, not the causes of a yield gap.";

    const cell = (c, row) =>
        !c ? (
            <span className="as-muted">No record</span>
        ) : (
            <>
                <span className="as-cond-val">
                    {fixed(c.value, row.digits)}
                    <small>{row.unit}</small>
                </span>
                <span className="as-delta">
                    {deltaText(c.delta, row.mode, row.deltaUnit ?? row.unit)}
                </span>
            </>
        );

    return (
        <Panel
            title={`Was ${year} a normal weather year?`}
            answer={answer}
            hint="Weather for this crop's growing season, against each district's own average. Soil is shown as background."
            takeaway={takeaway}
            className="as-cond-panel"
        >
            <div className="as-cond">
                <div className="as-cond-head">
                    <span />
                    <span className="as-cond-a">
                        <i className="as-dot as-dot-a" aria-hidden="true" /> {labelA}
                    </span>
                    <span className="as-cond-b">
                        <i className="as-dot as-dot-b" aria-hidden="true" /> {labelB}
                    </span>
                </div>
                {weather.map((row) => (
                    <div className="as-cond-row" key={row.key}>
                        <span className="as-cond-label">{row.label}</span>
                        <span className="as-cond-cell">{cell(row.a, row)}</span>
                        <span className="as-cond-cell">{cell(row.b, row)}</span>
                    </div>
                ))}
                {soil.length > 0 && (
                    <>
                        <div className="as-cond-sub">Soil, top 5 cm (model estimates, the same every year)</div>
                        {soil.map((row) => (
                            <div className="as-cond-row" key={row.label}>
                                <span className="as-cond-label">{row.label}</span>
                                <span className="as-cond-cell">
                                    {row.a === null ? <span className="as-muted">No record</span> : (
                                        <span className="as-cond-val">{fixed(row.a, row.digits)}<small>{row.unit}</small></span>
                                    )}
                                </span>
                                <span className="as-cond-cell">
                                    {row.b === null ? <span className="as-muted">No record</span> : (
                                        <span className="as-cond-val">{fixed(row.b, row.digits)}<small>{row.unit}</small></span>
                                    )}
                                </span>
                            </div>
                        ))}
                    </>
                )}
            </div>
        </Panel>
    );
}

function ComparisonSection({ view, ahead }) {
    return (
        <div className="as-cmp">
            <VersusBar view={view} />
            <p className="as-cmp-guide">
                Each box starts with its answer in one sentence. The chart under it shows where the answer comes from.
            </p>
            <LeadPanel view={view} ahead={ahead} />
            <div className="as-cmp-2">
                <ScalePanel view={view} />
                <ReliabilityPanel view={view} />
            </div>
            <ConditionsPanel view={view} />
        </div>
    );
}

function StartPanel() {
    return (
        <section className="as-start" aria-label="How to start">
            <span className="as-start-icon" aria-hidden="true">
                <Icon name="chart" size={26} />
            </span>
            <h2>Pick two districts to compare</h2>
            <p>
                Nothing is chosen for you. Select what you want to look at, then click Analyze. Your dashboard,
                comparison, insights and suggestions will appear here.
            </p>
            <ol className="as-start-steps">
                <li>
                    <span>1</span> Crop, season and year
                </li>
                <li>
                    <span>2</span> District A and District B
                </li>
                <li>
                    <span>3</span> Click Analyze
                </li>
            </ol>
            <p className="as-small as-muted">
                You can ask AgriScope AI any farming question on the right at any time.
            </p>
        </section>
    );
}

/* -------------------------------------------------------------------------- */
/*  AI insights and suggestions                                               */
/* -------------------------------------------------------------------------- */

function GenerateButton({ status, hasData, onGenerate, disabled }) {
    const loading = status === "loading";
    return (
        <button
            type="button"
            className={hasData ? "as-btn as-btn-secondary" : "as-btn as-btn-primary as-btn-inline"}
            onClick={onGenerate}
            disabled={loading || disabled}
        >
            {loading ? (
                <>
                    <Spinner label="Generating" /> Generating
                </>
            ) : (
                <>
                    <Icon name={hasData ? "refresh" : "sparkle"} size={15} />
                    {hasData ? "Regenerate" : "Generate with AI"}
                </>
            )}
        </button>
    );
}

function SkeletonGrid({ count }) {
    return (
        <div className="as-ai-grid" aria-hidden="true">
            {Array.from({ length: count }).map((_, index) => (
                <div className="as-ai-card as-skel" key={index}>
                    <span className="as-skel-line as-skel-tag" />
                    <span className="as-skel-line as-skel-title" />
                    <span className="as-skel-line" />
                    <span className="as-skel-line as-skel-short" />
                </div>
            ))}
        </div>
    );
}

function InsightCard({ item, number }) {
    return (
        <article className="as-ai-card">
            <div className="as-ai-head">
                <span className="as-ai-num" aria-hidden="true">
                    {number}
                </span>
                <h4>{item.title}</h4>
            </div>
            <div className="as-ai-part as-ai-data">
                <span>What the data shows</span>
                <p>{item.data}</p>
            </div>
            {item.meaning && (
                <div className="as-ai-part as-ai-meaning">
                    <span>What it may mean</span>
                    <p>{item.meaning}</p>
                </div>
            )}
            {item.figures_check === "unverified" && (
                <p className="as-warn">Please double-check the numbers in this one against the charts above.</p>
            )}
        </article>
    );
}

function SuggestionCard({ item, number }) {
    return (
        <article className="as-ai-card">
            <div className="as-ai-head">
                <span className="as-ai-num" aria-hidden="true">
                    {number}
                </span>
                <h4>{item.title}</h4>
            </div>
            <p className="as-ai-action">{item.action}</p>
            {item.why && (
                <div className="as-ai-part as-ai-meaning">
                    <span>Why</span>
                    <p>{item.why}</p>
                </div>
            )}
        </article>
    );
}

function AiState({ status, error, onGenerate, canGenerate, idleText, count }) {
    if (status === "loading") {
        return (
            <>
                <p className="as-loading-line as-small">
                    <Spinner /> Reading your data and preparing the insights{SYM.ellipsis}
                </p>
                <SkeletonGrid count={count} />
            </>
        );
    }
    if (status === "error") {
        return (
            <Alert
                title="We could not finish this."
                action={
                    <button type="button" className="as-btn as-btn-secondary" onClick={onGenerate} disabled={!canGenerate}>
                        <Icon name="refresh" size={15} /> Try again
                    </button>
                }
            >
                {error}
            </Alert>
        );
    }
    return (
        <div className="as-ai-idle">
            <Icon name="sparkle" size={22} />
            <p>{idleText}</p>
            <button type="button" className="as-btn as-btn-primary as-btn-inline" onClick={onGenerate} disabled={!canGenerate}>
                <Icon name="sparkle" size={15} /> Generate with AI
            </button>
        </div>
    );
}

function InsightsSection({ status, error, data, onGenerate, canGenerate, sectionRef }) {
    return (
        <section className="as-block" ref={sectionRef} aria-labelledby="as-sec-insights">
            <SectionHead
                n={3}
                id="as-sec-insights"
                title="Insights"
                subtitle="What your data says, and what it may mean on the farm"
                action={
                    data ? (
                        <GenerateButton status={status} hasData onGenerate={onGenerate} disabled={!canGenerate} />
                    ) : null
                }
            />
            {data ? (
                <>
                    <div className="as-ai-grid">
                        {data.insights.map((item, index) => (
                            <InsightCard item={item} number={index + 1} key={`${item.title}-${index}`} />
                        ))}
                    </div>
                    <p className="as-footnote">
                        The first part of each insight comes from your data. The second part is general farming
                        knowledge, so treat it as a likely explanation, not proof.
                    </p>
                </>
            ) : (
                <AiState
                    status={status}
                    error={error}
                    onGenerate={onGenerate}
                    canGenerate={canGenerate}
                    count={4}
                    idleText="Get four insights and four suggestions that combine your data with general farming knowledge."
                />
            )}
        </section>
    );
}

function SuggestionsSection({ status, data }) {
    return (
        <section className="as-block" aria-labelledby="as-sec-suggestions">
            <SectionHead
                n={4}
                id="as-sec-suggestions"
                title="Suggestions"
                subtitle="Practical things to try, based on this comparison"
            />
            {data ? (
                <>
                    <div className="as-ai-grid">
                        {data.recommendations.map((item, index) => (
                            <SuggestionCard item={item} number={index + 1} key={`${item.title}-${index}`} />
                        ))}
                    </div>
                    <p className="as-footnote">
                        These combine your data with general farming practice. Check what suits your own field with
                        your local agriculture office or Krishi Vigyan Kendra.
                    </p>
                </>
            ) : status === "loading" ? (
                <SkeletonGrid count={4} />
            ) : (
                <p className="as-small as-muted">Suggestions appear here together with the insights above.</p>
            )}
        </section>
    );
}

/* -------------------------------------------------------------------------- */
/*  Report (shown only after Analyze)                                         */
/* -------------------------------------------------------------------------- */

function Verdict({ view }) {
    const [yieldM] = view.metrics;
    const { labelA, labelB, year, season, recordA, recordB } = view;

    if (!recordA || !recordB) {
        const missing = [!recordA && labelA, !recordB && labelB].filter(Boolean).join(" or ");
        return (
            <div className="as-hero">
                <p className="as-hero-line">
                    There is no {season} {year} record for {missing}.
                </p>
                <p className="as-muted">
                    {recordA || recordB
                        ? "The values that exist are shown below, and the yield history covers the years on record."
                        : "The yield history below covers the years on record for each district."}
                </p>
            </div>
        );
    }

    if (isLevel(yieldM.a, yieldM.b)) {
        const shared = view.quality.selected_year_shared ?? {};
        const isShared = Boolean(shared[view.nameA] || shared[view.nameB]);
        return (
            <div className="as-hero as-hero-n">
                <p className="as-hero-line">
                    {labelA} and {labelB} had practically the same yield
                    <span className="as-hero-year"> in {season} {year}</span>
                </p>
                <p className="as-muted">
                    {fmt(yieldM.a, 0)} and {fmt(yieldM.b, 0)} kg/ha, less than 1% apart.
                    {isShared
                        ? " Several districts carry this same figure in the records, so this year cannot show which district really did better."
                        : ""}
                </p>
            </div>
        );
    }

    const winner = yieldM.higher;
    const loser = winner === "a" ? "b" : "a";
    const high = winner === "a" ? yieldM.a : yieldM.b;
    const low = winner === "a" ? yieldM.b : yieldM.a;

    return (
        <div className={`as-hero as-hero-${winner}`}>
            <p className="as-hero-line">
                <DistrictName which={winner}>{winner === "a" ? labelA : labelB}</DistrictName> had a{" "}
                {yieldM.percent !== null ? `${fmt(yieldM.percent, 1)}% ` : ""}higher yield than{" "}
                <DistrictName which={loser}>{loser === "a" ? labelA : labelB}</DistrictName>
                <span className="as-hero-year"> in {season} {year}</span>
            </p>
            <p className="as-muted">
                {fmtUnit(high, "kg/ha")} against {fmtUnit(low, "kg/ha")}, a gap of{" "}
                {fmtUnit(Math.abs(yieldM.difference), "kg/ha")}.
            </p>
        </div>
    );
}

function Report({ view, status, error, overview, overviewStatus, ai, save }) {
    const loading = status === "loading";
    const ahead = yearsAhead(view);
    const notes = qualityNotes(view);
    const hasRecord = Boolean(view.recordA || view.recordB);
    const rankInfo = rankInfoFor(view, overview);
    const kpis = buildKpis(view, rankInfo);
    const matches = overviewMatches(view, overview);

    return (
        <div className={`as-report${loading ? " as-is-updating" : ""}`} aria-busy={loading}>
            {status === "error" && (
                <Alert title="The new comparison could not be loaded.">
                    {error} The previous comparison is still shown.
                </Alert>
            )}
            {loading && (
                <div className="as-updating-note" role="status">
                    <Spinner label="Updating" /> Loading the new comparison{SYM.ellipsis}
                </div>
            )}

            <section className="as-block" aria-labelledby="as-comparison-title">
                <SectionHead
                    n={1}
                    id="as-comparison-title"
                    title="Dashboard"
                    subtitle={`${view.crop}, ${view.season} season, ${view.year}. Observed historical records.`}
                    action={
                        <button
                            type="button"
                            className="as-btn as-btn-secondary"
                            onClick={save.onSave}
                            disabled={save.state === "saving" || save.state === "saved"}
                        >
                            {save.state === "saving" ? "Saving" : save.state === "saved" ? "Saved" : "Save comparison"}
                        </button>
                    }
                />
                <Verdict view={view} />
                {save.message && (
                    <p className={`as-save-msg${save.state === "error" ? " is-error" : ""}`} role="status">
                        {save.message}
                    </p>
                )}

                {notes.length > 0 && (
                    <Alert tone="info" title="About these records">
                        <ul className="as-plain-list">
                            {notes.map((note) => (
                                <li key={note}>{note}</li>
                            ))}
                        </ul>
                    </Alert>
                )}

                {kpis.length > 0 && (
                    <div className="as-kpis">
                        {kpis.map(({ key, ...tile }) => (
                            <Kpi key={key} {...tile} />
                        ))}
                    </div>
                )}

                <div className="as-grid-2">
                    <Card
                        title="Yield over the years"
                        right={<Legend2 labelA={view.labelA} labelB={view.labelB} />}
                        takeaway={view.hasTrend ? takeawayTrend(view, ahead) : null}
                    >
                        {view.hasTrend ? (
                            <YieldTrend view={view} />
                        ) : (
                            <EmptyState
                                title="No yield history"
                                detail={`Neither district has ${view.crop} ${view.season} records in any year.`}
                            />
                        )}
                    </Card>

                    <Card
                        title={`Rank in Andhra Pradesh, ${view.year}`}
                        takeaway={matches ? takeawayRank(view, overview) : null}
                    >
                        {matches ? (
                            <RankingBars
                                ranking={overview.ranking}
                                mean={toNumber(overview.headline?.mean_yield)}
                                nameA={view.nameA}
                                nameB={view.nameB}
                            />
                        ) : overviewStatus === "error" ? (
                            <p className="as-small as-muted">The district ranking could not be loaded.</p>
                        ) : (
                            <div className="as-loading-line as-small">
                                <Spinner /> Loading the district ranking{SYM.ellipsis}
                            </div>
                        )}
                    </Card>
                </div>
            </section>

            {(hasRecord || view.hasTrend) && (
                <section className="as-block" aria-labelledby="as-sec-comparison">
                    <SectionHead
                        n={2}
                        id="as-sec-comparison"
                        title="Comparison"
                        subtitle="Four questions answered, beyond the numbers in the dashboard"
                    />
                    <ComparisonSection view={view} ahead={ahead} />
                </section>
            )}

            <InsightsSection
                status={ai.status}
                error={ai.error}
                data={ai.data}
                onGenerate={ai.onGenerate}
                canGenerate={ai.canGenerate}
                sectionRef={ai.sectionRef}
            />
            <SuggestionsSection status={ai.status} data={ai.data} />

            <p className="as-footnote">
                These are observed differences in the records. They do not show why the districts differ.
            </p>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/*  Chat                                                                      */
/* -------------------------------------------------------------------------- */

const markdownComponents = {
    a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

function AboutLine({ about, currentKey }) {
    if (!about) return null;
    const stale = about.key !== currentKey;
    return (
        <p className="as-about">
            About {about.label}
            {stale && <span className="as-stale"> (an earlier comparison)</span>}
        </p>
    );
}

function ChatMessage({ message, currentKey, canRetry, onRetry }) {
    if (message.role === "user") {
        return (
            <div className={`as-msg as-msg-user${message.type === "action" ? " as-msg-action" : ""}`}>
                {message.content}
            </div>
        );
    }

    if (message.type === "error") {
        return (
            <div className="as-msg as-msg-ai as-msg-error" role="alert">
                <p>{message.content}</p>
                {message.retry && canRetry && (
                    <button
                        type="button"
                        className="as-btn as-btn-secondary as-btn-small"
                        onClick={() => onRetry(message.retry)}
                    >
                        <Icon name="refresh" size={14} /> Try again
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="as-msg as-msg-ai" lang={message.language === "telugu" ? "te" : undefined}>
            <AboutLine about={message.about} currentKey={currentKey} />
            <div className="as-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {message.content}
                </ReactMarkdown>
            </div>
            {message.figuresCheck === "unverified" && (
                <p className="as-warn">Please double-check the numbers in this answer against the dashboard.</p>
            )}
        </div>
    );
}

function ChatPanel({
    language,
    onLanguage,
    panelRef,
    inputRef,
    messages,
    pending,
    input,
    onInput,
    onSend,
    onExplain,
    onInsights,
    onRetry,
    onNewChat,
    resultsReady,
    lock = false,
    resultsHint,
    currentKey,
}) {
    const logRef = useRef(null);
    const busy = pending !== null;
    const locked = busy || lock;
    const lastId = messages.length ? messages[messages.length - 1].id : null;

    useEffect(() => {
        const log = logRef.current;
        if (log) log.scrollTop = log.scrollHeight;
    }, [messages, pending]);

    useEffect(() => {
        const box = inputRef.current;
        if (!box) return;
        box.style.height = "auto";
        box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
    }, [input, inputRef]);

    function handleKeyDown(event) {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSend(input);
        }
    }

    return (
        <aside className="as-chat" ref={panelRef} aria-labelledby="as-chat-title">
            <div className="as-chat-head">
                <div>
                    <h2 id="as-chat-title">AgriScope AI</h2>
                    <p className="as-muted as-small">Ask me anything about farming, crops or soil. I can also explain your results.</p>
                    <div className="as-chat-lang">
                        <AiLanguageSwitch value={language} onChange={onLanguage} disabled={busy} />
                    </div>
                </div>
                {messages.length > 0 && (
                    <button type="button" className="as-btn as-btn-ghost as-btn-small" onClick={onNewChat} disabled={busy}>
                        New chat
                    </button>
                )}
            </div>

            <div className="as-chat-actions">
                <button type="button" className="as-ai-btn" onClick={onExplain} disabled={!resultsReady || locked}>
                    <Icon name="explain" size={18} />
                    <span>
                        <strong>Explain results</strong>
                        <small>What the numbers and charts mean</small>
                    </span>
                </button>
                <button type="button" className="as-ai-btn" onClick={onInsights} disabled={!resultsReady || locked}>
                    <Icon name="sparkle" size={18} />
                    <span>
                        <strong>Insights &amp; suggestions</strong>
                        <small>Patterns, possible reasons, next steps</small>
                    </span>
                </button>
                {!resultsReady && <p className="as-chat-hint">{resultsHint}</p>}
            </div>

            <div className="as-chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
                {messages.length === 0 && (
                    <div className="as-chat-empty">
                        <p className="as-small as-muted">Ask anything, for example:</p>
                        {STARTER_QUESTIONS.map((question) => (
                            <button
                                type="button"
                                key={question}
                                className="as-starter"
                                onClick={() => onSend(question)}
                                disabled={busy}
                            >
                                {question}
                            </button>
                        ))}
                        <p className="as-small as-muted as-chat-limits">
                            AgriScope AI cannot see live weather, market prices or advisories. Confirm pest and
                            treatment advice locally.
                        </p>
                    </div>
                )}
                {messages.map((message) => (
                    <ChatMessage
                        key={message.id}
                        message={message}
                        currentKey={currentKey}
                        canRetry={!busy && message.id === lastId}
                        onRetry={onRetry}
                    />
                ))}
                {busy && (
                    <div className="as-msg as-msg-ai as-typing">
                        <Spinner label={PENDING_LABELS[pending]} /> {PENDING_LABELS[pending]}
                        {SYM.ellipsis}
                    </div>
                )}
            </div>

            <div className="as-composer">
                <label htmlFor="as-chat-input" className="as-visually-hidden">
                    Message AgriScope AI
                </label>
                <textarea
                    id="as-chat-input"
                    ref={inputRef}
                    rows={1}
                    value={input}
                    placeholder="Ask AgriScope AI anything"
                    onChange={(event) => onInput(event.target.value)}
                    onKeyDown={handleKeyDown}
                    maxLength={2000}
                />
                <button
                    type="button"
                    className="as-send"
                    onClick={() => onSend(input)}
                    disabled={busy || !clean(input)}
                    aria-label="Send"
                >
                    <Icon name="send" size={17} />
                </button>
            </div>
            <p className="as-composer-hint">Enter sends. Shift+Enter adds a new line.</p>
        </aside>
    );
}

/* -------------------------------------------------------------------------- */
/*  Filters                                                                   */
/* -------------------------------------------------------------------------- */

function FilterBar({ options, filters, onChange, onAnalyze, onClear, canClear, loading, message, changed, yearHasData }) {
    const set = (field) => (event) => onChange(field, event.target.value);

    return (
        <section className="as-filterbar" aria-labelledby="as-filters-title">
            <h2 id="as-filters-title" className="as-visually-hidden">
                Choose what to compare
            </h2>
            <div className="as-fb-fields">
                <label className="as-field">
                    <span>Crop</span>
                    <select value={filters.crop} onChange={set("crop")}>
                        <option value="" disabled>
                            Select a crop
                        </option>
                        {options.crops.map((crop) => (
                            <option key={crop} value={crop}>
                                {crop}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="as-field">
                    <span>Season</span>
                    <select value={filters.season} onChange={set("season")}>
                        <option value="" disabled>
                            Select a season
                        </option>
                        {options.seasons.map((season) => (
                            <option key={season} value={season}>
                                {season}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="as-field">
                    <span>Year</span>
                    <select value={filters.year} onChange={set("year")}>
                        <option value="" disabled>
                            Select a year
                        </option>
                        {options.years.map((year) => {
                            const available = yearHasData(filters.crop, filters.season, year);
                            return (
                                <option key={year} value={String(year)} disabled={!available}>
                                    {available ? year : `${year} (no records)`}
                                </option>
                            );
                        })}
                    </select>
                </label>

                <label className="as-field">
                    <span>
                        <i className="as-dot as-dot-a" aria-hidden="true" /> District A
                    </span>
                    <select value={filters.districtA} onChange={set("districtA")}>
                        <option value="" disabled>
                            Select district A
                        </option>
                        {options.districts.map((district) => (
                            <option key={district} value={district} disabled={district === filters.districtB}>
                                {displayDistrict(district)}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="as-field">
                    <span>
                        <i className="as-dot as-dot-b" aria-hidden="true" /> District B
                    </span>
                    <select value={filters.districtB} onChange={set("districtB")}>
                        <option value="" disabled>
                            Select district B
                        </option>
                        {options.districts.map((district) => (
                            <option key={district} value={district} disabled={district === filters.districtA}>
                                {displayDistrict(district)}
                            </option>
                        ))}
                    </select>
                </label>

                <div className="as-fb-actions">
                    <button type="button" className="as-btn as-btn-primary" onClick={onAnalyze} disabled={loading}>
                        {loading ? (
                            <>
                                <Spinner label="Analyzing" /> Analyzing
                            </>
                        ) : (
                            "Analyze"
                        )}
                    </button>
                    {canClear && (
                        <button type="button" className="as-btn as-btn-ghost" onClick={onClear} disabled={loading}>
                            Clear
                        </button>
                    )}
                </div>
            </div>

            <div className="as-fb-message" aria-live="polite">
                {message ? (
                    <p className="as-filter-message as-filter-error">{message}</p>
                ) : changed ? (
                    <p className="as-filter-message">Filters changed. Click Analyze to update the dashboard below.</p>
                ) : null}
            </div>
        </section>
    );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

const EMPTY_FILTERS = { crop: "", season: "", year: "", districtA: "", districtB: "" };

export default function Dashboard() {
    const [summary, setSummary] = useState(null);
    const [summaryStatus, setSummaryStatus] = useState("loading");
    const [summaryError, setSummaryError] = useState("");

    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [validation, setValidation] = useState("");

    const [overview, setOverview] = useState(null);
    const [overviewStatus, setOverviewStatus] = useState("idle");
    const [overviewFor, setOverviewFor] = useState(null);
    const overviewRequest = useRef(0);

    // The last successfully analyzed comparison. It changes only when Analyze
    // succeeds or Clear is pressed, never when a filter changes.
    const [analysis, setAnalysis] = useState(null);
    const [analysisStatus, setAnalysisStatus] = useState("idle");
    const [saveState, setSaveState] = useState("idle");
    const [saveMessage, setSaveMessage] = useState("");
    const [analysisError, setAnalysisError] = useState("");
    const analysisRequest = useRef(0);
    const [restoreSelection, setRestoreSelection] = useState(null);
    const analysisKeyRef = useRef("");

    // AI insights and suggestions for the analyzed comparison.
    const [aiData, setAiData] = useState(null);
    const [aiStatus, setAiStatus] = useState("idle");
    const [aiError, setAiError] = useState("");
    const insightsRef = useRef(null);

    const [messages, setMessages] = useState(loadStoredChat);
    const [aiLanguage, setAiLanguage] = useAiLanguage();
    const [pending, setPending] = useState(null);
    const [input, setInput] = useState("");
    const chatPanelRef = useRef(null);
    const chatInputRef = useRef(null);

    /* ----- data loading ----- */

    const loadOverview = useCallback(async (selection) => {
        const requestId = ++overviewRequest.current;
        setOverviewFor({ crop: selection.crop, season: selection.season, year: Number(selection.year) });
        setOverviewStatus("loading");
        try {
            const params = new URLSearchParams({
                crop: selection.crop,
                season: selection.season,
                year: String(selection.year),
            });
            const data = await apiRequest(`/dashboard/overview?${params}`);
            if (requestId !== overviewRequest.current) return;
            setOverview(data);
            setOverviewStatus("ready");
        } catch {
            if (requestId !== overviewRequest.current) return;
            setOverviewStatus("error");
        }
    }, []);

    const loadSummary = useCallback(async () => {
        setSummaryStatus("loading");
        setSummaryError("");
        try {
            const data = await apiRequest("/dashboard/summary");
            setSummary(data);
            setSummaryStatus("ready");

            const crops = unique(data.crops ?? []);
            const seasons = unique(data.seasons ?? []).filter((s) => ALLOWED_SEASONS.includes(s.toLowerCase()));
            const districts = unique(data.districts ?? []);

            // Nothing is chosen for the person. Only a comparison they already
            // ran earlier in this browser session comes back, so results never
            // appear on their own. Clear starts again from an empty page.
            const stored = loadStoredSelection();
            const storedValid =
                stored &&
                crops.includes(stored.crop) &&
                seasons.includes(stored.season) &&
                districts.includes(stored.district_a) &&
                districts.includes(stored.district_b) &&
                stored.district_a !== stored.district_b &&
                toNumber(stored.year) !== null;

            if (storedValid) {
                setFilters({
                    crop: stored.crop,
                    season: stored.season,
                    year: String(stored.year),
                    districtA: stored.district_a,
                    districtB: stored.district_b,
                });
                setRestoreSelection({ ...stored, year: Number(stored.year) });
            } else {
                setFilters(EMPTY_FILTERS);
            }
        } catch (error) {
            setSummaryStatus("error");
            setSummaryError(error.message);
        }
    }, [loadOverview]);

    useEffect(() => {
        loadSummary();
    }, [loadSummary]);

    useEffect(() => {
        saveStoredChat(messages);
    }, [messages]);

    useEffect(() => {
        analysisKeyRef.current = analysis?.key ?? "";
    }, [analysis]);

    /* ----- filter options ----- */

    const options = useMemo(() => {
        if (!summary) return null;
        const start = toNumber(summary.period?.start_year);
        const end = toNumber(summary.period?.end_year);
        const years = [];
        if (start !== null && end !== null) {
            for (let year = start; year <= end; year += 1) years.push(year);
        }
        const coverage = new Map(
            (summary.coverage ?? []).map((c) => [
                `${clean(c.crop).toLowerCase()}|${clean(c.season).toLowerCase()}`,
                new Set((c.years ?? []).map(Number)),
            ])
        );
        return {
            crops: unique(summary.crops ?? []),
            seasons: unique(summary.seasons ?? []).filter((s) => ALLOWED_SEASONS.includes(s.toLowerCase())),
            districts: unique(summary.districts ?? []),
            years,
            coverage,
        };
    }, [summary]);

    const yearHasData = useCallback(
        (crop, season, year) => {
            const years = options?.coverage.get(`${clean(crop).toLowerCase()}|${clean(season).toLowerCase()}`);
            // Without coverage information every year is offered; the
            // comparison then shows its own empty state.
            return years ? years.has(Number(year)) : true;
        },
        [options]
    );

    function validateFilters(current) {
        if (!current.crop || !current.season || !current.year || !current.districtA || !current.districtB) {
            return "Choose a crop, season, year and two districts.";
        }
        if (current.districtA === current.districtB) {
            return "Choose two different districts.";
        }
        if (!yearHasData(current.crop, current.season, current.year)) {
            return `There are no ${current.crop} ${current.season} records for ${current.year}. Choose another year.`;
        }
        return "";
    }

    function changeFilter(field, value) {
        const next = { ...filters, [field]: value };
        setFilters(next);
        // Keep an earlier message only while it still applies.
        if (validation) setValidation(validateFilters(next));
    }

    /* ----- analyze ----- */

    function analyze() {
        const problem = validateFilters(filters);
        setValidation(problem);
        if (problem) return;
        runAnalysis(selectionFromFilters(filters));
    }

    async function runAnalysis(selection) {
        const requestId = ++analysisRequest.current;
        setAnalysisStatus("loading");
        setAnalysisError("");

        try {
            const params = new URLSearchParams({
                district_a: selection.district_a,
                district_b: selection.district_b,
                crop: selection.crop,
                season: selection.season,
                year: String(selection.year),
            });
            const data = await apiRequest(`/dashboard/compare?${params}`);
            if (requestId !== analysisRequest.current) return;

            const key = selectionKey(selection);
            setAnalysis({ selection, key, data });
            setAnalysisStatus("ready");
            saveStoredSelection(selection);

            // New comparison: earlier AI text no longer applies, unless the
            // same comparison was generated before in this session.
            const storedInsights = loadStoredInsights();
            if (storedInsights && storedInsights.key === key) {
                setAiData(storedInsights.data);
                setAiStatus("ready");
            } else {
                setAiData(null);
                setAiStatus("idle");
            }
            setAiError("");

            const overviewOk =
                overviewFor &&
                overviewFor.crop === selection.crop &&
                overviewFor.season === selection.season &&
                overviewFor.year === selection.year &&
                overviewStatus !== "error";
            if (!overviewOk) loadOverview(selection);
        } catch (error) {
            if (requestId !== analysisRequest.current) return;
            setAnalysisStatus("error");
            setAnalysisError(error.message);
        }
    }

    // Re-open the comparison that was showing before the user left the page.
    useEffect(() => {
        if (!restoreSelection) return;
        setRestoreSelection(null);
        runAnalysis(restoreSelection);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [restoreSelection]);

    // A new comparison can be saved again; the old "Saved" note no longer applies.
    useEffect(() => {
        setSaveState("idle");
        setSaveMessage("");
    }, [analysis?.key]);

    async function saveComparison() {
        if (!analysis || saveState === "saving") return;
        const { selection } = analysis;
        setSaveState("saving");
        setSaveMessage("");
        try {
            const data = await apiRequest("/saved-comparisons", {
                method: "POST",
                body: {
                    crop: selection.crop,
                    season: selection.season,
                    year: selection.year,
                    district_a: selection.district_a,
                    district_b: selection.district_b,
                },
            });
            setSaveState("saved");
            setSaveMessage(
                data.already_saved
                    ? "This comparison was already saved."
                    : "Saved. You can open it again from My Profile."
            );
        } catch (error) {
            setSaveState("error");
            setSaveMessage(error.message);
        }
    }

    function clearAnalysis() {
        saveStoredSelection(null);
        saveStoredInsights(null);
        analysisRequest.current += 1;
        setAnalysis(null);
        setAnalysisStatus("idle");
        setAnalysisError("");
        setAiData(null);
        setAiStatus("idle");
        setAiError("");
        setValidation("");
        setFilters(EMPTY_FILTERS);
    }

    const view = useMemo(
        () => (analysis ? buildComparison(analysis.data, summary?.period) : null),
        [analysis, summary]
    );

    const filtersChanged =
        Boolean(analysis) && filters.year !== "" && selectionKey(selectionFromFilters(filters)) !== analysis.key;

    /* ----- AI insights and suggestions ----- */

    const busy = pending !== null;
    const resultsReady =
        Boolean(view) && analysisStatus !== "loading" && Boolean(view.recordA || view.recordB || view.hasTrend);
    const resultsHint = !analysis
        ? "Analyze a comparison to use these buttons."
        : analysisStatus === "loading"
            ? "Waiting for the new comparison."
            : "This comparison has no records to explain.";

    function addMessages(...items) {
        setMessages((previous) => [...previous, ...items.map((item) => ({ id: newId(), ...item }))]);
    }

    // Retrying replaces the failed attempt instead of stacking a second one.
    function dropLastFailure() {
        setMessages((previous) => {
            const next = [...previous];
            if (next[next.length - 1]?.type === "error") next.pop();
            if (next[next.length - 1]?.type === "action") next.pop();
            return next;
        });
    }

    function scrollToInsights() {
        requestAnimationFrame(() => {
            const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
            insightsRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
        });
    }

    async function generateInsights({ fromChat = false, isRetry = false } = {}) {
        if (!resultsReady || aiStatus === "loading") return;
        if (fromChat && busy) return;
        if (isRetry) dropLastFailure();

        const snapshot = analysis;
        const about = { key: snapshot.key, label: describeSelection(snapshot.selection) };
        if (fromChat) {
            addMessages({ role: "user", type: "action", content: "Insights & suggestions" });
            setPending("insights");
        }
        setAiStatus("loading");
        setAiError("");

        try {
            const data = await apiRequest("/dashboard/insights", {
                method: "POST",
                timeoutMs: 90000,
                body: { ...snapshot.selection, language: aiLanguage },
            });
            // The user may have analyzed something else while this was running.
            if (analysisKeyRef.current !== snapshot.key) {
                setAiStatus("idle");
                return;
            }
            setAiData(data);
            setAiStatus("ready");
            saveStoredInsights({ key: snapshot.key, data });
            if (fromChat) {
                addMessages({
                    role: "assistant",
                    type: "text",
                    content:
                        "Your insights and suggestions are ready. You will find them in sections 3 and 4 of the dashboard.",
                    about,
                });
                scrollToInsights();
            }
        } catch (error) {
            if (analysisKeyRef.current !== snapshot.key) {
                setAiStatus("idle");
                return;
            }
            setAiStatus("error");
            setAiError(error.message);
            if (fromChat) {
                addMessages({ role: "assistant", type: "error", content: error.message, retry: "insights" });
            }
        } finally {
            if (fromChat) setPending(null);
        }
    }

    /* ----- chat ----- */

    function historyForApi(list) {
        return list
            .filter((m) => m.type !== "error" && clean(m.content))
            .slice(-CHAT_HISTORY_TURNS)
            .map((m) => ({ role: m.role, content: m.content.slice(0, CHAT_HISTORY_CHARS) }));
    }

    async function sendChat(text) {
        const question = clean(text);
        if (!question || busy) return;

        const history = historyForApi(messages);
        const snapshot = analysis;
        addMessages({ role: "user", type: "text", content: question });
        setInput("");
        setPending("chat");

        try {
            const data = await apiRequest("/dashboard/chat", {
                method: "POST",
                timeoutMs: 60000,
                body: { question, mode: "chat", language: aiLanguage, history, ...(snapshot ? snapshot.selection : {}) },
            });
            addMessages({ role: "assistant", type: "text", content: data.answer, language: aiLanguage });
        } catch (error) {
            addMessages({ role: "assistant", type: "error", content: error.message });
            setInput((current) => current || question);
        } finally {
            setPending(null);
        }
    }

    async function explainResults(isRetry = false) {
        if (!resultsReady || busy || aiStatus === "loading") return;
        if (isRetry === true) dropLastFailure();
        const snapshot = analysis;
        const about = { key: snapshot.key, label: describeSelection(snapshot.selection) };
        addMessages({ role: "user", type: "action", content: "Explain results" });
        setPending("explain");

        try {
            const data = await apiRequest("/dashboard/chat", {
                method: "POST",
                timeoutMs: 60000,
                body: {
                    question: "Explain the comparison currently shown on my dashboard.",
                    mode: "explain",
                    language: aiLanguage,
                    history: [],
                    ...snapshot.selection,
                },
            });
            addMessages({
                role: "assistant",
                type: "text",
                content: data.answer,
                about,
                figuresCheck: data.figures_check,
            });
        } catch (error) {
            addMessages({ role: "assistant", type: "error", content: error.message, retry: "explain" });
        } finally {
            setPending(null);
        }
    }

    function retry(kind) {
        if (kind === "explain") explainResults(true);
        else if (kind === "insights") generateInsights({ fromChat: true, isRetry: true });
    }

    function newChat() {
        setMessages([]);
        setInput("");
    }

    /* ----- render ----- */

    const period = summary?.period;
    const ai = {
        status: aiStatus,
        error: aiError,
        data: aiData,
        onGenerate: () => generateInsights(),
        canGenerate: resultsReady && !busy,
        sectionRef: insightsRef,
    };

    return (
        <div className="as-dash">
            <style>{DASHBOARD_CSS}</style>
            <div className="as-layout">
                <div className="as-main">
                    <header className="as-page-head">
                        <h1>Crop performance dashboard</h1>
                        <p>
                            Compare two Andhra Pradesh districts for rice or dry chillies
                            {period ? `, ${period.start_year}${SYM.ndash}${period.end_year}` : ""}.
                        </p>
                    </header>

                    {summaryStatus === "error" ? (
                        <section className="as-card">
                            <Alert
                                title="The dashboard data could not be loaded."
                                action={
                                    <button type="button" className="as-btn as-btn-secondary" onClick={loadSummary}>
                                        <Icon name="refresh" size={15} /> Try again
                                    </button>
                                }
                            >
                                {summaryError}
                            </Alert>
                        </section>
                    ) : summaryStatus === "loading" || !options ? (
                        <section className="as-card as-loading-line" aria-busy="true">
                            <Spinner /> Loading the dashboard{SYM.ellipsis}
                        </section>
                    ) : (
                        <>
                            <FilterBar
                                options={options}
                                filters={filters}
                                onChange={changeFilter}
                                onAnalyze={analyze}
                                onClear={clearAnalysis}
                                canClear={Boolean(analysis)}
                                loading={analysisStatus === "loading"}
                                message={validation}
                                changed={filtersChanged}
                                yearHasData={yearHasData}
                            />

                            {view ? (
                                <Report
                                    view={view}
                                    status={analysisStatus}
                                    error={analysisError}
                                    overview={overview}
                                    overviewStatus={overviewStatus}
                                    ai={ai}
                                    save={{ state: saveState, message: saveMessage, onSave: saveComparison }}
                                />
                            ) : (
                                <>
                                    {analysisStatus === "error" && (
                                        <Alert title="The comparison could not be loaded.">{analysisError}</Alert>
                                    )}
                                    {analysisStatus === "loading" ? (
                                        <div className="as-card as-loading-line" aria-busy="true">
                                            <Spinner /> Loading the comparison{SYM.ellipsis}
                                        </div>
                                    ) : (
                                        <StartPanel />
                                    )}
                                </>
                            )}
                        </>
                    )}
                </div>

                <ChatPanel
                    language={aiLanguage}
                    onLanguage={setAiLanguage}
                    panelRef={chatPanelRef}
                    inputRef={chatInputRef}
                    messages={messages}
                    pending={pending}
                    input={input}
                    onInput={setInput}
                    onSend={sendChat}
                    onExplain={() => explainResults()}
                    onInsights={() => generateInsights({ fromChat: true })}
                    onRetry={retry}
                    onNewChat={newChat}
                    resultsReady={resultsReady}
                    lock={aiStatus === "loading"}
                    resultsHint={resultsHint}
                    currentKey={analysis?.key ?? ""}
                />
            </div>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/*  Styles (scoped with the "as-" prefix, matching the app's palette)         */
/* -------------------------------------------------------------------------- */

const DASHBOARD_CSS = `
.as-dash {
    container-type: inline-size;
    color: ${COLOR.ink};
    font-size: 14px;
    line-height: 1.5;
}
.as-layout { display: grid; gap: 22px; align-items: start; }
.as-main { display: grid; gap: 22px; min-width: 0; }

.as-dash h1, .as-dash h2, .as-dash h3, .as-dash h4 { margin: 0; color: ${COLOR.ink}; }
.as-muted { color: ${COLOR.muted}; }
.as-small { font-size: 13px; }
.as-footnote { margin: 0; font-size: 12.5px; color: ${COLOR.muted}; }
.as-visually-hidden {
    position: absolute !important;
    width: 1px; height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
}
.as-loading-line { display: flex; align-items: center; gap: 10px; color: ${COLOR.muted}; }
.as-plain-list { margin: 4px 0 0; padding-left: 18px; }
.as-name { font-weight: 700; }
.as-name-a { color: ${COLOR.aText}; }
.as-name-b { color: ${COLOR.bText}; }
.as-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.as-dot-a { background: ${COLOR.a}; }
.as-dot-b { background: ${COLOR.b}; }

.as-page-head h1 { font-size: 26px; font-weight: 750; letter-spacing: -0.5px; }
.as-page-head p { margin: 4px 0 0; color: ${COLOR.muted}; }

.as-card {
    background: ${COLOR.surface};
    border: 1px solid #e3eadf;
    border-radius: 16px;
    padding: 18px 20px;
    box-shadow: 0 1px 2px rgba(24, 34, 24, 0.04), 0 6px 18px rgba(24, 34, 24, 0.04);
    min-width: 0;
}

/* Filter bar */
.as-filterbar {
    display: grid;
    gap: 14px;
    background: ${COLOR.surface};
    border: 1px solid #e3eadf;
    border-radius: 16px;
    padding: 16px 18px;
    box-shadow: 0 1px 2px rgba(24, 34, 24, 0.04), 0 6px 18px rgba(24, 34, 24, 0.04);
}
.as-fb-fields {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px 14px;
}
.as-fb-actions { display: flex; gap: 8px; align-self: end; }
.as-fb-actions .as-btn-primary { flex: 1; min-width: 0; }
.as-fb-message { min-height: 0; }
.as-fb-message:empty { display: none; }
.as-field { display: grid; gap: 5px; min-width: 0; }
.as-field > span {
    font-size: 12.5px;
    font-weight: 650;
    color: ${COLOR.muted};
    display: flex;
    align-items: center;
    gap: 6px;
}
.as-field select {
    height: 42px;
    width: 100%;
    border: 1px solid #d3dccd;
    border-radius: 11px;
    padding: 0 10px;
    background: #fbfcfa;
    color: ${COLOR.ink};
    font: inherit;
    font-size: 14px;
}
.as-filter-message { margin: 0; font-size: 13px; color: ${COLOR.muted}; }
.as-filter-error { color: #9b2c1f; font-weight: 600; }

/* Buttons */
.as-btn {
    height: 40px;
    padding: 0 16px;
    border-radius: 10px;
    font: inherit;
    font-size: 14px;
    font-weight: 650;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    white-space: nowrap;
}
.as-btn:disabled { cursor: not-allowed; opacity: 0.6; }
.as-btn-primary { min-width: 140px; background: ${COLOR.a}; color: #fff; border: 1px solid ${COLOR.a}; }
.as-btn-primary:hover:not(:disabled) { background: #183d28; }
.as-btn-secondary { background: #fff; color: ${COLOR.a}; border: 1px solid #cfdcca; height: 34px; }
.as-btn-ghost { background: transparent; color: ${COLOR.muted}; border: 1px solid #dde4d9; }
.as-btn-ghost:hover:not(:disabled) { background: #f3f6ef; }
.as-btn-small { height: 30px; padding: 0 10px; font-size: 12.5px; }
.as-btn-primary .as-spinner { border-color: rgba(255,255,255,0.35); border-top-color: #fff; }

/* Sections */
.as-block { display: grid; gap: 16px; min-width: 0; }
.as-report { display: grid; gap: 34px; }
.as-sh { display: flex; align-items: center; gap: 12px; }
.as-sh-n {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: ${COLOR.a};
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    display: grid;
    place-items: center;
}
.as-sh-text { flex: 1; min-width: 0; }
.as-sh h2 { font-size: 19px; font-weight: 750; letter-spacing: -0.3px; }
.as-sh-text p { margin: 1px 0 0; font-size: 13px; color: ${COLOR.muted}; }
.as-sh-action { flex-shrink: 0; }
.as-is-updating > :not(.as-updating-note):not(.as-alert) { opacity: 0.55; }
.as-updating-note { display: flex; align-items: center; gap: 8px; font-size: 13px; color: ${COLOR.muted}; }

/* Headline */
.as-hero {
    background: #eef5ec;
    border: 1px solid #dbe8d8;
    border-radius: 16px;
    padding: 18px 22px;
    box-shadow: inset 5px 0 0 ${COLOR.a};
}
.as-hero-n { background: #f1f4ef; border-color: #e0e6dc; box-shadow: inset 5px 0 0 #9aa89c; }
.as-hero-b { background: #fbf3e0; border-color: #f0e1ba; box-shadow: inset 5px 0 0 ${COLOR.b}; }
.as-hero p { margin: 0; }
.as-hero-line { font-size: 23px; font-weight: 700; line-height: 1.3; letter-spacing: -0.4px; margin-bottom: 4px !important; }
.as-hero-year { font-weight: 500; color: ${COLOR.muted}; font-size: 17px; }

/* KPI tiles */
.as-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.as-kpi {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
    align-content: start;
    background: ${COLOR.surface};
    border: 1px solid #e3eadf;
    border-radius: 14px;
    padding: 14px 16px 14px;
    box-shadow: inset 0 4px 0 #d8dfd4, 0 1px 2px rgba(24, 34, 24, 0.04);
    min-width: 0;
}
.as-kpi-a { box-shadow: inset 0 4px 0 ${COLOR.a}, 0 1px 2px rgba(24, 34, 24, 0.04); }
.as-kpi-b { box-shadow: inset 0 4px 0 ${COLOR.b}, 0 1px 2px rgba(24, 34, 24, 0.04); }
.as-kpi-label { font-size: 12.5px; font-weight: 650; color: ${COLOR.muted}; }
.as-kpi-value {
    font-size: 27px;
    font-weight: 750;
    letter-spacing: -0.6px;
    line-height: 1.25;
    font-variant-numeric: tabular-nums;
    overflow-wrap: break-word;
}
.as-kpi-value small { font-size: 13px; font-weight: 600; color: ${COLOR.muted}; margin-left: 5px; letter-spacing: 0; }
.as-kpi-a .as-kpi-value { color: ${COLOR.aText}; }
.as-kpi-b .as-kpi-value { color: ${COLOR.bText}; }
.as-kpi-sub { font-size: 12.5px; color: ${COLOR.muted}; }

/* Chart cards */
.as-grid-2 { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); }
.as-card-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.as-card-head h3 { font-size: 15px; font-weight: 700; }
.as-legend { display: flex; gap: 14px; font-size: 12.5px; color: ${COLOR.muted}; }
.as-legend span { display: inline-flex; align-items: center; gap: 6px; }
.as-grid-2 > .as-card { display: flex; flex-direction: column; }
.as-fill { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.as-chart-box { flex: 1; min-width: 0; margin: 0 -4px; position: relative; min-height: 230px; }
.as-take {
    margin: 12px 0 0;
    padding: 9px 12px;
    background: #f4f8f1;
    border-radius: 10px;
    font-size: 13px;
}

/* District ranking */
.as-rank { display: grid; }
.as-rk {
    display: grid;
    grid-template-columns: 20px 114px minmax(0, 1fr) 46px;
    align-items: center;
    gap: 8px;
    height: 29px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 12.5px;
}
.as-rk-n { color: ${COLOR.muted}; text-align: center; font-variant-numeric: tabular-nums; font-size: 11.5px; }
.as-rk-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: ${COLOR.muted}; }
.as-rk-track { position: relative; height: 100%; display: flex; align-items: center; }
.as-rk-track i { display: block; height: 11px; border-radius: 6px; background: #cfd9d1; }
.as-rk-avg { position: absolute; top: 0; bottom: 0; border-left: 1.5px dashed #6e7d71; }
.as-rk-val { text-align: right; font-variant-numeric: tabular-nums; color: ${COLOR.muted}; }
.as-rk-a { background: #e8f2ea; }
.as-rk-a .as-rk-track i { background: ${COLOR.a}; }
.as-rk-a .as-rk-name, .as-rk-a .as-rk-val { color: ${COLOR.aText}; font-weight: 700; }
.as-rk-b { background: #faf1dc; }
.as-rk-b .as-rk-track i { background: ${COLOR.b}; }
.as-rk-b .as-rk-name, .as-rk-b .as-rk-val { color: ${COLOR.bText}; font-weight: 700; }
.as-rk-note { margin-top: 8px; display: flex; align-items: center; gap: 6px; }
.as-rk-key { display: inline-block; width: 0; height: 12px; border-left: 1.5px dashed #6e7d71; }

/* Start panel (before Analyze) */
.as-start {
    display: grid;
    justify-items: center;
    gap: 12px;
    text-align: center;
    padding: 40px 24px 34px;
    background: ${COLOR.surface};
    border: 1.5px dashed #cbd8c8;
    border-radius: 20px;
}
.as-start-icon {
    width: 56px;
    height: 56px;
    border-radius: 18px;
    background: #e4f0e2;
    color: ${COLOR.a};
    display: grid;
    place-items: center;
}
.as-start h2 { font-size: 22px; font-weight: 750; letter-spacing: -0.4px; }
.as-start p { margin: 0; max-width: 58ch; color: ${COLOR.muted}; }
.as-start-steps { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; list-style: none; padding: 0; margin: 6px 0 4px; }
.as-start-steps li {
    display: flex;
    align-items: center;
    gap: 9px;
    background: #f1f6ee;
    border-radius: 999px;
    padding: 7px 16px 7px 8px;
    font-size: 13.5px;
    font-weight: 600;
}
.as-start-steps li span {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: ${COLOR.a};
    color: #fff;
    font-size: 12.5px;
    font-weight: 700;
    display: grid;
    place-items: center;
}

/* Tiles that show both districts */
.as-kpi-dual { gap: 4px; }
.as-kpi-dual.lead-a { box-shadow: inset 0 4px 0 ${COLOR.a}, 0 1px 2px rgba(24, 34, 24, 0.04); }
.as-kpi-dual.lead-b { box-shadow: inset 0 4px 0 ${COLOR.b}, 0 1px 2px rgba(24, 34, 24, 0.04); }
.as-dual { display: grid; gap: 5px; margin: 2px 0 3px; }
.as-dual-stack .as-dual-row { flex-direction: column; align-items: flex-start; gap: 0; }
.as-dual-stack .as-dual-val { text-align: left; }
.as-dual-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; }
.as-dual-name { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; color: ${COLOR.muted}; min-width: 0; }
.as-dual-val { font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
.as-dual-val b { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
.as-dual-val small { font-size: 11.5px; font-weight: 500; color: ${COLOR.muted}; margin-left: 4px; }
.as-dual-a .as-dual-val b { color: ${COLOR.aText}; }
.as-dual-b .as-dual-val b { color: ${COLOR.bText}; }
.has-lead .as-dual-row:not(.is-lead) .as-dual-val b { font-size: 16px; font-weight: 600; opacity: 0.7; }
.has-lead .as-dual-row.is-lead .as-dual-val b { font-size: 22px; font-weight: 800; }
.has-lead .as-dual-row.is-lead .as-dual-name { color: ${COLOR.ink}; }

/* Comparison */
.as-cmp { display: grid; gap: 14px; }
.as-cmp-2 { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); }
.as-vs-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; }
.as-vs-team { display: flex; align-items: center; gap: 12px; min-width: 0; }
.as-vs-team > span:not(.as-avatar) { display: grid; min-width: 0; }
.as-vs-team strong { font-size: 18px; font-weight: 750; letter-spacing: -0.3px; overflow-wrap: anywhere; color: ${COLOR.aText}; }
.as-vs-team small { font-size: 12px; color: ${COLOR.muted}; }
.as-vs-team-b { text-align: right; }
.as-vs-team-b strong { color: ${COLOR.bText}; }
.as-avatar {
    flex-shrink: 0;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 14px;
    font-weight: 750;
    color: #fff;
}
.as-avatar-a { background: ${COLOR.a}; }
.as-avatar-b { background: ${COLOR.b}; }
.as-vs-badge {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 700;
    color: ${COLOR.muted};
    border: 1px solid #dde4d9;
    border-radius: 999px;
    padding: 3px 12px;
    background: #f7f9f5;
}
.as-panel { display: grid; align-content: start; gap: 14px; }
.as-pn-head h3 { font-size: 15.5px; font-weight: 700; letter-spacing: -0.2px; }
.as-pn-head p { margin: 2px 0 0; font-size: 12.5px; color: ${COLOR.muted}; }
.as-panel .as-take { margin: 0; }
.as-answer { margin: 0; font-size: 17px; font-weight: 700; line-height: 1.4; letter-spacing: -0.2px; color: ${COLOR.ink}; }
.as-cmp-guide { margin: 0; font-size: 13px; color: ${COLOR.muted}; }
.as-fill-a { background: ${COLOR.a}; }
.as-fill-b { background: ${COLOR.b}; }

/* Who led each year */
.as-lead-score { display: flex; flex-wrap: wrap; gap: 6px 20px; font-size: 13px; color: ${COLOR.muted}; }
.as-lead-score b { font-size: 20px; font-weight: 750; margin-right: 4px; letter-spacing: -0.4px; }
.as-lead-a b { color: ${COLOR.aText}; }
.as-lead-b b { color: ${COLOR.bText}; }
.as-lead-n b { color: ${COLOR.muted}; }
.as-strip { display: grid; grid-template-columns: repeat(var(--n, 18), minmax(0, 1fr)); gap: 4px; }
.as-strip-cell {
    display: grid;
    place-items: center;
    aspect-ratio: 1 / 1.1;
    border-radius: 8px;
    color: #fff;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    cursor: default;
}
.as-strip-cell b { font-weight: 650; opacity: 0.92; }
.as-strip-a { background: ${COLOR.a}; }
.as-strip-b { background: ${COLOR.b}; }
.as-strip-tie { background: #8f9b92; }
.as-strip-none { background: #e7ece4; color: #8f9b92; }
.as-strip-cell.is-sel { outline: 2px solid ${COLOR.ink}; outline-offset: 2px; }
.as-strip-axis { display: flex; justify-content: space-between; font-size: 11.5px; color: ${COLOR.muted}; margin-top: -6px; }

/* Scale of farming */
.as-share-list { display: grid; gap: 20px; }
.as-share-title { font-size: 13px; font-weight: 650; margin-bottom: 7px; }
.as-share-bar { display: flex; height: 28px; gap: 2px; }
.as-share-bar i {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 6px;
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    font-style: normal;
}
.as-share-bar .as-fill-a { border-radius: 999px 0 0 999px; }
.as-share-bar .as-fill-b { border-radius: 0 999px 999px 0; }
.as-share-vals { display: flex; justify-content: space-between; gap: 10px; margin-top: 7px; font-size: 13px; color: ${COLOR.muted}; }
.as-share-vals > span { display: grid; }
.as-share-vals small { font-size: 11.5px; }
.as-share-num { white-space: nowrap; }
.as-share-vals b { font-size: 17px; font-weight: 750; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; }
.as-share-a b { color: ${COLOR.aText}; }
.as-share-b { text-align: right; }
.as-share-b b { color: ${COLOR.bText}; }

/* Reliability */
.as-rel { display: grid; gap: 18px; }
.as-rel-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px 12px; margin-bottom: 9px; }
.as-rel-name { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
.as-rel-name .as-chip { margin-left: 4px; }
.as-rel-stats { display: flex; gap: 14px; font-size: 12.5px; color: ${COLOR.muted}; }
.as-rel-stats b { color: ${COLOR.ink}; font-size: 15px; }
.as-rel-dots { display: grid; grid-template-columns: repeat(var(--n, 18), minmax(0, 1fr)); gap: 4px; }
.as-rel-dot { display: block; aspect-ratio: 1; border-radius: 50%; }
.as-rel-ok { background: #c6d5c9; }
.as-rel-bad { background: #d2573f; }
.as-rel-none { background: transparent; border: 1.5px dashed #c3ccc1; }
.as-rel-key { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; font-size: 12px; color: ${COLOR.muted}; }
.as-rel-key span { display: inline-flex; align-items: center; gap: 6px; }
.as-rel-key .as-rel-dot { display: inline-block; width: 10px; height: 10px; aspect-ratio: auto; }
.as-rel-years { margin-left: auto; }

/* Growing conditions */
.as-cond { display: grid; }
.as-cond-head, .as-cond-row {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr);
    gap: 14px;
    align-items: center;
}
.as-cond-head { padding-bottom: 8px; border-bottom: 1px solid #e8ede4; font-size: 13px; font-weight: 700; }
.as-cond-head span { display: flex; align-items: center; gap: 7px; }
.as-cond-a { color: ${COLOR.aText}; }
.as-cond-b { color: ${COLOR.bText}; }
.as-cond-row { padding: 12px 0; border-bottom: 1px solid #f0f3ee; }
.as-cond-label { font-size: 13px; font-weight: 600; }
.as-cond-cell { display: grid; gap: 2px; }
.as-cond-val { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; }
.as-cond-val small { font-size: 12px; font-weight: 500; color: ${COLOR.muted}; margin-left: 4px; }
.as-delta { font-size: 12px; color: ${COLOR.muted}; }
.as-cond-sub { font-size: 12px; font-weight: 700; color: ${COLOR.a}; margin: 16px 0 2px; }

/* AI insights and suggestions */
.as-ai-grid { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
.as-ai-card {
    display: grid;
    gap: 11px;
    align-content: start;
    background: ${COLOR.surface};
    border: 1px solid #e3eadf;
    border-radius: 16px;
    padding: 16px 18px 17px;
    box-shadow: 0 1px 2px rgba(24, 34, 24, 0.04), 0 6px 18px rgba(24, 34, 24, 0.04);
    min-width: 0;
}
.as-ai-head { display: flex; align-items: center; gap: 10px; }
.as-ai-num {
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #e4f0e2;
    color: ${COLOR.a};
    font-size: 12.5px;
    font-weight: 750;
    display: grid;
    place-items: center;
}
.as-ai-card h4 { font-size: 15.5px; font-weight: 700; letter-spacing: -0.2px; }
.as-ai-part { display: grid; gap: 2px; padding-left: 12px; border-left: 3px solid #cfe0cb; }
.as-ai-part > span { font-size: 11.5px; font-weight: 700; letter-spacing: 0.02em; }
.as-ai-part p { margin: 0; font-size: 13.5px; color: #2f3d33; }
.as-ai-data { border-left-color: #5e9c70; }
.as-ai-data > span { color: #2d6a43; }
.as-ai-meaning { border-left-color: #a496cf; }
.as-ai-meaning > span { color: #5a4b8a; }
.as-ai-action { margin: 0; font-size: 14px; font-weight: 600; color: #1e2a21; }
.as-save-msg { margin: -6px 0 0; font-size: 13px; color: ${COLOR.a}; font-weight: 600; }
.as-save-msg.is-error { color: #9b2c1f; }
.as-ai-idle {
    display: grid;
    justify-items: center;
    gap: 10px;
    text-align: center;
    padding: 26px 18px;
    border: 1.5px dashed #cfdacb;
    border-radius: 16px;
    background: #fbfcfa;
    color: ${COLOR.a};
}
.as-ai-idle p { margin: 0; max-width: 52ch; color: ${COLOR.muted}; }
.as-skel { box-shadow: none; }
.as-skel-line {
    display: block;
    height: 11px;
    border-radius: 6px;
    margin: 9px 0;
    background: linear-gradient(90deg, #eef2ec 25%, #f8faf6 50%, #eef2ec 75%);
    background-size: 200% 100%;
    animation: as-shimmer 1.4s linear infinite;
}
.as-skel-tag { width: 90px; height: 18px; border-radius: 999px; }
.as-skel-title { width: 62%; height: 14px; }
.as-skel-short { width: 45%; }
@keyframes as-shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .as-skel-line { animation: none; } }

.as-empty {
    display: grid;
    justify-items: center;
    text-align: center;
    gap: 6px;
    padding: 28px 16px;
    color: ${COLOR.muted};
}
.as-empty strong { color: ${COLOR.ink}; font-size: 15px; }
.as-empty p { margin: 0; max-width: 46ch; }

.as-alert {
    display: flex;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid #f0cdc6;
    background: #fdf3f1;
    color: #6f2117;
    font-size: 13.5px;
}
.as-alert-info { border-color: #dfe6d8; background: #f6f8f3; color: ${COLOR.ink}; }
.as-alert-icon { flex-shrink: 0; padding-top: 1px; }
.as-alert-content { display: grid; gap: 3px; }
.as-alert-action { margin-top: 6px; }

.as-tooltip {
    background: #fff;
    border: 1px solid ${COLOR.line};
    border-radius: 10px;
    padding: 8px 10px;
    box-shadow: 0 6px 18px rgba(24, 34, 24, 0.12);
    font-size: 12.5px;
    display: grid;
    gap: 3px;
}
.as-tooltip-row { display: flex; align-items: center; gap: 6px; }
.as-tooltip-row b { margin-left: auto; padding-left: 10px; font-variant-numeric: tabular-nums; }
.as-tooltip-dot { width: 8px; height: 8px; border-radius: 50%; }

.as-spinner {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 2px solid #d6e3d3;
    border-top-color: ${COLOR.a};
    animation: as-spin 0.8s linear infinite;
    display: inline-block;
    flex-shrink: 0;
}
@keyframes as-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
    .as-spinner { animation-duration: 2.4s; }
}

/* Chat */
.as-chat {
    background: ${COLOR.surface};
    border: 1px solid #e2e8dc;
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    height: 620px;
    min-width: 0;
    overflow: hidden;
    scroll-margin-top: 92px;
}
.as-chat-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    padding: 16px 16px 10px;
}
.as-chat-head h2 { font-size: 17px; font-weight: 750; }
.as-chat-head p { margin: 2px 0 0; }
.as-chat-actions {
    display: grid;
    gap: 8px;
    padding: 0 16px 12px;
    border-bottom: 1px solid #edf0e9;
}
.as-ai-btn {
    display: flex;
    align-items: center;
    gap: 11px;
    min-height: 52px;
    padding: 8px 12px;
    border-radius: 12px;
    border: 1px solid #cfe0ca;
    background: #e8f2e5;
    color: ${COLOR.a};
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.as-ai-btn svg { flex-shrink: 0; }
.as-ai-btn span { display: grid; gap: 1px; }
.as-ai-btn strong { font-size: 14px; font-weight: 700; }
.as-ai-btn small { font-size: 12px; font-weight: 500; color: #4a6a53; }
.as-ai-btn:hover:not(:disabled) { background: #dcebd7; }
.as-ai-btn:disabled { cursor: not-allowed; opacity: 0.5; }
.as-chat-hint { margin: 0; font-size: 12px; color: ${COLOR.muted}; }
.as-chat-log {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: #fbfcf9;
}
.as-chat-empty { display: grid; gap: 7px; }
.as-chat-empty p { margin: 0; }
.as-starter {
    text-align: left;
    border: 1px solid #dfe6da;
    background: #fff;
    border-radius: 10px;
    padding: 8px 10px;
    font: inherit;
    font-size: 13px;
    color: ${COLOR.ink};
    cursor: pointer;
}
.as-starter:hover:not(:disabled) { border-color: #c4d6be; background: #f6faf4; }
.as-chat-limits { margin-top: 6px !important; }
.as-msg {
    max-width: 94%;
    padding: 9px 12px;
    border-radius: 14px;
    font-size: 13.5px;
    overflow-wrap: anywhere;
}
.as-msg-user {
    align-self: flex-end;
    background: #e8f2e5;
    border-bottom-right-radius: 4px;
    white-space: pre-wrap;
}
.as-msg-action { font-weight: 650; color: ${COLOR.a}; }
.as-msg-ai {
    align-self: flex-start;
    background: #fff;
    border: 1px solid #e3e9df;
    border-bottom-left-radius: 4px;
}
.as-msg-error { background: #fdf3f1; border-color: #f0cdc6; color: #6f2117; display: grid; gap: 8px; justify-items: start; }
.as-msg-error p { margin: 0; }
.as-typing { display: flex; align-items: center; gap: 8px; color: ${COLOR.muted}; }
.as-about { margin: 0 0 6px; font-size: 12px; color: ${COLOR.muted}; font-weight: 600; }
.as-stale { color: #8a4b12; font-weight: 600; }
.as-warn { margin: 8px 0 0; font-size: 12px; color: #8a4b12; }
.as-markdown > :first-child { margin-top: 0; }
.as-markdown > :last-child { margin-bottom: 0; }
.as-markdown h1, .as-markdown h2, .as-markdown h3, .as-markdown h4 { font-size: 13.5px; font-weight: 750; margin: 12px 0 4px; }
.as-markdown p { margin: 0 0 8px; }
.as-markdown ul, .as-markdown ol { margin: 0 0 8px; padding-left: 18px; }
.as-markdown li { margin: 2px 0; }
.as-markdown table { border-collapse: collapse; font-size: 12.5px; margin: 6px 0; display: block; overflow-x: auto; }
.as-markdown th, .as-markdown td { border: 1px solid #e3e9df; padding: 4px 6px; }
.as-markdown a { color: ${COLOR.a}; }

.as-composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 10px 12px 4px;
    border-top: 1px solid #edf0e9;
}
.as-composer textarea {
    flex: 1;
    resize: none;
    min-height: 40px;
    max-height: 140px;
    border: 1px solid #d3dccd;
    border-radius: 10px;
    padding: 9px 11px;
    font: inherit;
    font-size: 14px;
    line-height: 1.4;
    color: ${COLOR.ink};
}
.as-send {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 10px;
    border: 0;
    background: ${COLOR.a};
    color: #fff;
    display: grid;
    place-items: center;
    cursor: pointer;
}
.as-send:disabled { opacity: 0.45; cursor: not-allowed; }
.as-composer-hint { margin: 0; padding: 0 14px 10px; font-size: 11.5px; color: ${COLOR.muted}; }

.as-dash :focus-visible {
    outline: 2px solid ${COLOR.a};
    outline-offset: 2px;
}
.as-dash select:focus-visible, .as-dash textarea:focus-visible { outline-offset: 0; }


/* Responsive rules last, so they override the base rules above. The page is
   measured by its own width, not the screen: the chat sits beside the
   dashboard on wide pages and below it on narrow ones. */
@container (min-width: 700px) and (max-width: 939px) {
    .as-grid-2, .as-cmp-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .as-ai-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .as-ai-grid > :last-child:nth-child(odd) { grid-column: 1 / -1; }
}
@container (max-width: 640px) {
    .as-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .as-fb-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .as-hero-line { font-size: 20px; }
    .as-vs-bar { padding: 12px 14px; }
    .as-vs-team strong { font-size: 15px; }
    .as-avatar { width: 36px; height: 36px; font-size: 12.5px; }
    .as-strip { gap: 3px; }
    .as-strip-cell b { display: none; }
    .as-cond-head, .as-cond-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .as-cond-head > span:first-child { display: none; }
    .as-cond-label { grid-column: 1 / -1; }
    .as-rk { grid-template-columns: 20px 92px minmax(0, 1fr) 46px; }
    .as-sh { flex-wrap: wrap; }
    .as-sh-action { margin-left: 42px; }
}
@container (min-width: 940px) {
    .as-layout { grid-template-columns: minmax(0, 3fr) minmax(300px, 1fr); }
    .as-chat {
        position: sticky;
        top: 92px;
        height: calc(100vh - 120px);
        min-height: 480px;
    }
}
@container (min-width: 1000px) {
    .as-grid-2, .as-cmp-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .as-ai-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .as-ai-grid > :last-child:nth-child(odd) { grid-column: 1 / -1; }
}
`;