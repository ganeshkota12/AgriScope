
// Make sure this is 8000 (not 8001)
const API_BASE_URL = (import.meta.env?.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')

async function request(endpoint, options) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, options)
    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
        const detail = data.detail
        throw new Error(
            typeof detail === 'string'
                ? detail
                : 'The request failed. Please try again.'
        )
    }

    return data
}

export function registerUser({ name, email, password }) {
    return request('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
    })
}

export function loginUser({ email, password }) {
    return request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    })
}

export function predictYield({ district, crop, season, year }) {
    return request('/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            district: district.trim(),
            crop,
            season,
            year: Number(year),
        }),
    })
}
