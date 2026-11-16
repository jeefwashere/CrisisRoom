// Pure logic for the "Live transcript" side panel (no JSX, no network) so it can be unit tested.
// The call stage shows only tiles; everything spoken (briefing, turns, experts, the private coach) lands here.
import type { ExpertTake, PrivateMessage } from '../../services/facilitation.ts'
import type { Recording } from '../../services/rooms.ts'
import { transitionIndex } from './privateSessionModel.ts'

export type TranscriptTone = 'agent' | 'expert' | 'coach' | 'self' | 'member' | 'system'

/** Progressive reveal: the text types out from `startedAt` over `durationMs` (the audio's length). */
export type Reveal = { startedAt: number; durationMs: number }

export type TranscriptEntry = {
    id: string
    speaker: string
    /** Short tag beside the name ("AI agent", "Expert", "You", the member's scenario role). */
    role: string
    tone: TranscriptTone
    text: string
    /** Optional accent colour for the speaker name (experts). */
    accent?: string
    /** The line is being spoken right now ("Speaking" dot). */
    live: boolean
    /** Null shows the full text at once. */
    reveal: Reveal | null
}

export type TranscriptInput = Omit<TranscriptEntry, 'live' | 'reveal'>

export type TranscriptAction =
    | { type: 'upsert'; entry: TranscriptInput }
    | { type: 'speak'; entry: TranscriptInput; at: number; durationMs: number | null }
    | { type: 'done'; id: string }
    | { type: 'place'; entry: TranscriptInput; replaces?: string; before?: readonly string[] }
    | { type: 'clear' }

/** Oldest lines drop off beyond this, so a long game never grows the panel without bound. */
export const MAX_TRANSCRIPT_ENTRIES = 300
/** Roughly the pace of spoken ElevenLabs speech; used when an audio length is unknown. */
export const SPEECH_CHARS_PER_SECOND = 15
export const CAPTIONS_STORAGE_KEY = 'boardroom.captions'

function sameInput(entry: TranscriptEntry, input: TranscriptInput): boolean {
    return entry.speaker === input.speaker && entry.role === input.role && entry.tone === input.tone && entry.text === input.text && entry.accent === input.accent
}

function capped(entries: TranscriptEntry[]): TranscriptEntry[] {
    return entries.length > MAX_TRANSCRIPT_ENTRIES ? entries.slice(entries.length - MAX_TRANSCRIPT_ENTRIES) : entries
}

/**
 * Transcript state transitions. `upsert` adds a line with its full text (or updates an existing line's text in place,
 * keeping its position). `speak` adds or updates a line and starts revealing it in time with its audio; only one line
 * is live at a time. `done` ends the live state and shows the whole line. `place` adds a line that arrives late (a
 * saved transcript) where it belongs: in the place of the line it `replaces` (its live preview), else before the first
 * line whose ID starts with one of `before` (the lines of later turns), else at the end. Unchanged input returns the
 * same array.
 */
export function transcriptReducer(state: TranscriptEntry[], action: TranscriptAction): TranscriptEntry[] {
    switch (action.type) {
        case 'upsert': {
            const index = state.findIndex((entry) => entry.id === action.entry.id)
            if (index === -1) return capped([...state, { ...action.entry, live: false, reveal: null }])
            if (sameInput(state[index], action.entry)) return state
            return state.map((entry, position) => position === index ? { ...entry, ...action.entry } : entry)
        }
        case 'speak': {
            const reveal = action.durationMs !== null && action.durationMs > 0 ? { startedAt: action.at, durationMs: action.durationMs } : null
            const ended = state.map((entry) => entry.live && entry.id !== action.entry.id ? { ...entry, live: false, reveal: null } : entry)
            const index = ended.findIndex((entry) => entry.id === action.entry.id)
            const next: TranscriptEntry = { ...action.entry, live: true, reveal }
            if (index === -1) return capped([...ended, next])
            return ended.map((entry, position) => position === index ? next : entry)
        }
        case 'done': {
            const index = state.findIndex((entry) => entry.id === action.id)
            if (index === -1 || (!state[index].live && !state[index].reveal)) return state
            return state.map((entry, position) => position === index ? { ...entry, live: false, reveal: null } : entry)
        }
        case 'place': {
            const next: TranscriptEntry = { ...action.entry, live: false, reveal: null }
            const existing = state.findIndex((entry) => entry.id === action.entry.id)
            const replaced = action.replaces ? state.findIndex((entry) => entry.id === action.replaces) : -1
            if (replaced !== -1) return state.flatMap((entry, position) => position === replaced ? [next] : position === existing ? [] : [entry])
            if (existing !== -1) {
                if (sameInput(state[existing], action.entry)) return state
                return state.map((entry, position) => position === existing ? { ...entry, ...action.entry } : entry)
            }
            const later = action.before?.length ? state.findIndex((entry) => action.before!.some((prefix) => entry.id.startsWith(prefix))) : -1
            return capped(later === -1 ? [...state, next] : [...state.slice(0, later), next, ...state.slice(later)])
        }
        case 'clear':
            return state.length ? [] : state
    }
}

/** Estimated speaking time for text without a known audio length. */
export function estimateSpeechMs(text: string, charsPerSecond = SPEECH_CHARS_PER_SECOND): number {
    return Math.round((text.length / Math.max(1, charsPerSecond)) * 1000)
}

/** Reveal length for an audio element or clip duration in seconds; falls back to the estimate when unknown. */
export function speechDurationMs(seconds: number | null | undefined, text: string): number {
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : estimateSpeechMs(text)
}

/**
 * How long a line without audio holds the floor before the next one starts (the stage moves on silently).
 * Roughly its speaking time plus a short pause, optionally capped so silent sessions do not drag.
 */
export function silentHoldMs(text: string, charsPerSecond: number, pauseMs: number, maxMs = Number.POSITIVE_INFINITY): number {
    return Math.min(maxMs, estimateSpeechMs(text, charsPerSecond) + pauseMs)
}

/** Characters of `text` revealed at `now`; the whole text without a reveal or once its time is up. */
export function revealedLength(text: string, reveal: Reveal | null, now: number): number {
    if (!reveal || reveal.durationMs <= 0) return text.length
    const ratio = (now - reveal.startedAt) / reveal.durationMs
    if (ratio >= 1) return text.length
    if (ratio <= 0) return 0
    return Math.min(text.length, Math.ceil(text.length * ratio))
}

/** The revealed prefix, cut at the end of the last whole word so captions never show half a word. */
export function revealedText(text: string, reveal: Reveal | null, now: number): string {
    const count = revealedLength(text, reveal, now)
    if (count >= text.length) return text
    const prefix = text.slice(0, count)
    if (/\s/.test(text[count] ?? '')) return prefix
    const cut = prefix.search(/\s\S*$/)
    return cut === -1 ? '' : prefix.slice(0, cut)
}

/** Captions default to hidden; only an explicit "1" stored for this tab (the Captions button) shows them. */
export function captionsPreference(raw: string | null | undefined): boolean {
    return raw === '1'
}

// Entry builders: stable IDs per spoken line, so repeated renders update one line instead of adding another.

export function briefingEntry(opening: { speech_id: string | null; text: string }): TranscriptInput {
    return { id: `opening:${opening.speech_id ?? opening.text.length}`, speaker: 'Preparation agent', role: 'AI agent', tone: 'agent', text: opening.text }
}

export function expertEntry(roundId: string, take: Pick<ExpertTake, 'kind' | 'label' | 'text'>, accent?: string): TranscriptInput {
    return { id: `expert:${roundId}:${take.kind}`, speaker: take.label, role: 'Expert', tone: 'expert', text: take.text, ...(accent ? { accent } : {}) }
}

export function turnEntry(turn: string, member: { name: string; role: string }, text: string, self: boolean): TranscriptInput {
    return { id: `turn:${turn}`, speaker: self ? `${member.name} (you)` : member.name, role: member.role, tone: self ? 'self' : 'member', text }
}

/** ID of the live line for the caller's own Mic recording in one speaking turn. */
export const micLiveId = (phaseId: string): string => `mic:${phaseId}`

/**
 * The caller's own words while their Mic records, as the browser hears them. A preview: the server's transcript of
 * the same turn replaces this line when it arrives.
 */
export function micLiveEntry(phaseId: string, member: { name: string; role: string }, text: string): TranscriptInput {
    return { id: micLiveId(phaseId), speaker: `${member.name} (you)`, role: `${member.role} · Live words`, tone: 'self', text }
}

/**
 * ID prefixes of the transcript lines that belong to speaking turns after the turn `phaseId`: the turn lines, live
 * Mic lines and saved recordings of every later finished turn and of the current one. A transcript that arrives late
 * goes before the first of them. Empty while `phaseId` is still the current turn.
 */
export function laterTurnLines(phaseId: string, turns: readonly { phase_id: string }[], currentPhaseId: string | null | undefined,
    recordings: readonly { recording_id: string; phase_id: string }[]): string[] {
    const index = turns.findIndex((turn) => turn.phase_id === phaseId)
    if (index === -1) return []
    const later = turns.slice(index + 1).map((turn) => turn.phase_id)
    if (currentPhaseId && currentPhaseId !== phaseId && !later.includes(currentPhaseId)) later.push(currentPhaseId)
    return [...later.flatMap((phase) => [`turn:${phase}`, micLiveId(phase)]),
        ...recordings.filter((recording) => later.includes(recording.phase_id)).map((recording) => `recording:${recording.recording_id}`)]
}

/** The latest words of a live caption for a one line strip: the tail, cut at a word, with a leading ellipsis. */
export function liveTail(text: string, max = 80): string {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean.length <= max) return clean
    const tail = clean.slice(clean.length - max)
    const space = tail.indexOf(' ')
    return `…${space === -1 ? tail : tail.slice(space + 1)}`
}

export function recordingTranscriptEntry(recording: Pick<Recording, 'recording_id' | 'status' | 'transcript' | 'reviewed_text'>,
    member: { name: string; role: string }, self: boolean): TranscriptInput | null {
    const reviewed = recording.status === 'reviewed'
    if (!reviewed && recording.status !== 'review_required') return null
    const text = (reviewed ? recording.reviewed_text : recording.transcript)?.trim()
    if (!text) return null
    return { id: `recording:${recording.recording_id}`, speaker: self ? `${member.name} (you)` : member.name,
        role: `${member.role} · ${reviewed ? 'Reviewed transcript' : 'Unreviewed transcript'}`, tone: self ? 'self' : 'member', text }
}

export function privateAgentName(agentName: string, round: number): string {
    return round === 3 ? `${agentName} · examiner` : agentName
}

/** One private session message as a transcript line: the coach's lines, the member's answers, failures as notes. */
export function privateEntry(message: Pick<PrivateMessage, 'message_id' | 'author' | 'round' | 'status' | 'text' | 'used_clip'>, agentName: string, selfName: string): TranscriptInput {
    const id = `private:${message.message_id}`
    // Answers from a saved clip (including the prerecorded Rounds 1 and 2 of a Round 3 test start) keep the saved answer label.
    if (message.author === 'member') return { id, speaker: `${selfName} (you)`, role: message.used_clip ? 'Saved answer' : message.round === 3 ? 'Answer' : 'You', tone: 'self', text: message.text }
    if (message.status === 'failed') return { id, speaker: privateAgentName(agentName, message.round), role: 'Note', tone: 'system', text: message.text || 'This reply could not be prepared.' }
    return { id, speaker: privateAgentName(agentName, message.round), role: message.round === 3 ? 'Examiner' : 'Crisis coach', tone: 'coach', text: message.text }
}

export function privateAutoEntry(key: string, selfName: string, text: string): TranscriptInput {
    return { id: `private-auto:${key}`, speaker: `${selfName} (you)`, role: 'Saved answer', tone: 'self', text }
}

export function assessmentDividerEntry(agentName: string): TranscriptInput {
    return { id: 'private:round3-divider', speaker: 'Round 3 · Assessment begins', role: 'Scored', tone: 'system', text: `Your preparation is complete. ${agentName} is now your examiner and only Round 3 answers earn points.` }
}

/**
 * Private session lines to show (in full) for the messages revealed so far: everything up to `upTo` except the line
 * being voiced now (`currentId`, which is spoken in step with its audio) and pending replies. The Round 3 hand over
 * gets a divider line. Member answers whose text was already captioned from an Auto response clip are skipped.
 */
export function privateTranscriptLines(messages: readonly PrivateMessage[], upTo: number, currentId: string | null, agentName: string, selfName: string,
    captioned: ReadonlySet<string> = new Set()): TranscriptInput[] {
    const handover = transitionIndex(messages)
    const lines: TranscriptInput[] = []
    messages.slice(0, upTo).forEach((message, index) => {
        if (index === handover && handover > 0) lines.push(assessmentDividerEntry(agentName))
        if (message.message_id === currentId || message.status === 'pending') return
        if (message.author === 'member' && captioned.has(message.text.trim())) return
        lines.push(privateEntry(message, agentName, selfName))
    })
    return lines
}
