// Small request helper for the Weather and Soil pages.
const API_URL = (import.meta.env?.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')

export async function getJson(path) {
    let response
    try {
        response = await fetch(`${API_URL}${path}`)
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
        throw new Error(typeof detail === 'string' && detail ? detail : 'Something went wrong. Please try again.')
    }
    return payload
}

export function titleCase(text) {
    return String(text ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

export function displayDistrict(name) {
    return titleCase(name).replace(/\bSpsr\b/g, 'SPSR')
}

export function formatNumber(value, digits = 0) {
    const n = Number(value)
    if (value === null || value === undefined || !Number.isFinite(n)) return 'Not available'
    return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function ordinalWord(n) {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
    return n < words.length ? words[n] : String(n)
}