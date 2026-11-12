import { useEffect, useState } from 'react'
import './AiLanguage.css'

/* The reply-language switch shared by the dashboard and yield chat panels.
   Only the assistant's replies change language; the page itself stays in English. */

export const AI_LANGUAGES = [
    { id: 'english', label: 'English', lang: 'en' },
    { id: 'telugu', label: 'తెలుగు', lang: 'te' },
]

const STORAGE_KEY = 'agriscope-ai-language'

export function useAiLanguage() {
    const [language, setLanguage] = useState(() => {
        const stored = sessionStorage.getItem(STORAGE_KEY)
        return AI_LANGUAGES.some((item) => item.id === stored) ? stored : 'english'
    })

    useEffect(() => {
        sessionStorage.setItem(STORAGE_KEY, language)
    }, [language])

    return [language, setLanguage]
}

export function AiLanguageSwitch({ value, onChange, disabled = false }) {
    function onKey(event) {
        // Arrow keys move between the two choices, as in any radio group.
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        const index = AI_LANGUAGES.findIndex((item) => item.id === value)
        const next = AI_LANGUAGES[(index + (event.key === 'ArrowRight' ? 1 : -1) + AI_LANGUAGES.length) % AI_LANGUAGES.length]
        onChange(next.id)
        document.getElementById(`ai-lang-${next.id}`)?.focus()
    }

    return (
        <div className="ai-lang" role="radiogroup" aria-label="Reply language">
            {AI_LANGUAGES.map((item) => {
                const active = value === item.id
                return (
                    <button
                        key={item.id}
                        id={`ai-lang-${item.id}`}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        tabIndex={active ? 0 : -1}
                        lang={item.lang}
                        className={`ai-lang-option${active ? ' is-active' : ''}`}
                        onClick={() => onChange(item.id)}
                        onKeyDown={onKey}
                        disabled={disabled}
                    >
                        {item.label}
                    </button>
                )
            })}
        </div>
    )
}