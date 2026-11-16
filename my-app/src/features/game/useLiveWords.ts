import { useEffect, useState } from 'react'
import { appendTranscript, createSpeechReader, speechRecognitionConstructor } from './dictationModel'

/**
 * The words the browser's own speech recognition hears while the Mic records a speaking turn, for a live caption.
 * `session` names the recording (its turn) and null means not recording. It is a preview only: the saved transcript
 * still comes from the server after Stop. Browsers without speech recognition return no words.
 */
export function useLiveWords(session: string | null): string {
    const [heard, setHeard] = useState({ session: '', text: '' })
    useEffect(() => {
        if (!session) return
        const Recognition = typeof window === 'undefined' ? null : speechRecognitionConstructor(window)
        if (!Recognition) return
        let stopped = false
        let finals = ''
        // Sessions that ended without hearing anything, in a row; a browser that cannot recognise is left alone.
        let empty = 0
        let current: InstanceType<typeof Recognition> | null = null
        const listen = () => {
            if (stopped) return
            try {
                const instance = new Recognition()
                instance.lang = 'en-US'
                instance.continuous = true
                instance.interimResults = true
                const read = createSpeechReader()
                instance.onresult = (event) => {
                    const { final, interim } = read(event)
                    finals = appendTranscript(finals, final)
                    empty = 0
                    if (!stopped) setHeard({ session, text: appendTranscript(finals, interim) })
                }
                // A preview only: errors are silent, and the recording itself is unaffected. Where the browser refuses
                // or cannot reach its recogniser, stop asking.
                instance.onerror = (event) => { if (event.error !== 'no-speech' && event.error !== 'aborted') stopped = true }
                // The browser ends a session after a pause; keep listening for as long as the Mic records.
                instance.onend = () => { current = null; empty += 1; if (empty <= 8) setTimeout(listen, 250) }
                instance.start()
                current = instance
            } catch { current = null }
        }
        listen()
        return () => {
            stopped = true
            if (current) { current.onend = null; current.abort() }
        }
    }, [session])
    return session && heard.session === session ? heard.text : ''
}
