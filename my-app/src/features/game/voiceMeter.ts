// Loudness of the voices playing in this window, for the 3D characters' mouths (boardroom3d/faceExpressions.ts).
//
// Every voice is an HTMLAudioElement. A metered element is analysed through `captureStream()`, which taps the
// audio without rerouting it: the element keeps playing to the speakers exactly as before, so a meter that fails
// can never silence a voice. Where the tap is missing or blocked (Firefox, Safari, audio from another origin, a
// suspended AudioContext) the voice is reported as playing but unmetered, and the scene falls back to its
// procedural mouth. The analyser is never connected to the speakers.
//
// Frames of the same origin share one list of playing voices: in the judge demo the bots' clips play in the demo
// page while the 3D scene runs in the player's frame inside it.

/** What the scene can know about the voices playing right now. */
export type VoiceReading =
    /** No metered voice is playing in this window. */
    | { state: 'silent' }
    /** A voice is playing, but its loudness cannot be read here. */
    | { state: 'unmetered' }
    /** The playing voice: RMS loudness (0 to about 0.4 for speech) and how bright it sounds (0 dark, 1 bright). */
    | { state: 'level'; level: number; brightness: number }

type Capturable = HTMLMediaElement & { captureStream?: () => MediaStream }

type Meter = {
    element: HTMLMediaElement
    /** `Date.now()` when playback last started (frames have different `performance.now()` origins). */
    since: number
    /** The audio context of the frame that plays the element. */
    context: AudioContext | null
    /** The tap was attempted (once per element, whether or not it worked). */
    tried: boolean
    source: MediaStreamAudioSourceNode | null
    analyser: AnalyserNode | null
    samples: Float32Array<ArrayBuffer> | null
    spectrum: Float32Array<ArrayBuffer> | null
    /** The analyser has delivered sound at least once, so a later zero is a pause and not a dead tap. */
    heard: boolean
}

/** A tap that has delivered nothing this long after playback started is treated as dead. */
const DEAD_TAP_MS = 900
const meters = new WeakMap<HTMLMediaElement, Meter>()
let context: AudioContext | null = null
let shared: Set<Meter> | null = null

/** The voices playing now, shared with the other frames of this origin (kept on the top window that allows it). */
function playingVoices(): Set<Meter> {
    if (shared) return shared
    let host: Window = window
    try {
        if (window.top && window.top.location.origin === window.location.origin) host = window.top
    } catch { /* The page is embedded by another origin: keep the list to this frame. */ }
    const holder = host as Window & { __boardroomVoices?: Set<Meter> }
    shared = holder.__boardroomVoices ??= new Set<Meter>()
    return shared
}

function audioContext(): AudioContext | null {
    if (context) return context
    if (typeof AudioContext === 'undefined') return null
    try { context = new AudioContext() } catch { return null }
    return context
}

function connect(meter: Meter, stream: MediaStream) {
    const audio = audioContext()
    if (!audio || meter.source || stream.getAudioTracks().length === 0) return
    meter.context = audio
    const analyser = audio.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.5
    const source = audio.createMediaStreamSource(stream)
    source.connect(analyser)
    meter.source = source
    meter.analyser = analyser
    meter.samples = new Float32Array(analyser.fftSize)
    meter.spectrum = new Float32Array(analyser.frequencyBinCount)
}

function tap(meter: Meter) {
    if (meter.tried) return
    meter.tried = true
    try {
        const capture = (meter.element as Capturable).captureStream
        if (typeof capture !== 'function') return
        const stream = capture.call(meter.element)
        // Tracks can arrive after the stream (a line that is still downloading).
        if (stream.getAudioTracks().length > 0) connect(meter, stream)
        else stream.addEventListener('addtrack', () => { try { connect(meter, stream) } catch { /* stays unmetered */ } })
    } catch {
        // Cross origin audio or an unsupported element: the voice plays on, unmetered.
    }
}

function started(meter: Meter) {
    meter.since = Date.now()
    playingVoices().add(meter)
    tap(meter)
    // A context made before the first click starts suspended; by now the player has interacted with the page.
    if (context?.state === 'suspended') void context.resume().catch(() => undefined)
}

/**
 * Meter a voice for the 3D mouths. Safe to call for any audio element, before or after it starts, and more than
 * once; it only listens and never changes how the element plays.
 */
export function meterVoice(element: HTMLMediaElement): void {
    if (typeof window === 'undefined' || meters.has(element)) return
    const meter: Meter = { element, since: 0, context: null, tried: false, source: null, analyser: null, samples: null, spectrum: null, heard: false }
    meters.set(element, meter)
    const stopped = () => { playingVoices().delete(meter) }
    element.addEventListener('playing', () => started(meter))
    for (const event of ['pause', 'ended', 'emptied', 'error']) element.addEventListener(event, stopped)
    if (!element.paused && !element.ended && element.readyState > 2) started(meter)
}

/** RMS of a block of samples (each -1 to 1). */
export function rms(samples: ArrayLike<number>): number {
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0
}

/** Lower and upper edge of the band whose balance tells rounded sounds (oo, oh) from spread ones (ee, s). */
const BRIGHT_BAND = { from: 250, to: 4000 }
/** Spectral centroids at or below `dark` hertz read as fully rounded, at or above `bright` as fully spread. */
const CENTROID = { dark: 700, bright: 1700 }

/**
 * How bright a spectrum sounds, 0 to 1, from its centroid between 250 Hz and 4 kHz. `decibels` holds one value per
 * analyser bin and `binHz` is the width of a bin. A rough vowel cue (rounded vowels sit low, spread ones high),
 * not phoneme recognition.
 */
export function brightness(decibels: ArrayLike<number>, binHz: number): number {
    let weight = 0
    let moment = 0
    const first = Math.max(1, Math.round(BRIGHT_BAND.from / binHz))
    const last = Math.min(decibels.length - 1, Math.round(BRIGHT_BAND.to / binHz))
    for (let bin = first; bin <= last; bin++) {
        const magnitude = 10 ** (decibels[bin] / 20)
        if (!Number.isFinite(magnitude)) continue
        weight += magnitude
        moment += magnitude * bin * binHz
    }
    if (weight <= 0) return 0.5
    return Math.min(1, Math.max(0, (moment / weight - CENTROID.dark) / (CENTROID.bright - CENTROID.dark)))
}

/** The voices playing in this window right now: the loudest metered one, else whether any is playing at all. */
export function readVoice(): VoiceReading {
    const playing = playingVoices()
    if (playing.size === 0) return { state: 'silent' }
    const now = Date.now()
    let best: { level: number; brightness: number } | null = null
    let unmetered = false
    for (const meter of playing) {
        // A voice whose frame went away never reports its end: drop it once it is no longer playing.
        let live = false
        try { live = !meter.element.paused && !meter.element.ended } catch { /* The frame is gone. */ }
        if (!live) { playing.delete(meter); continue }
        const { analyser, samples, spectrum, context: audio } = meter
        if (!analyser || !samples || !spectrum || audio?.state !== 'running') { unmetered = true; continue }
        analyser.getFloatTimeDomainData(samples)
        const level = rms(samples)
        if (level > 1e-4) meter.heard = true
        else if (!meter.heard && now - meter.since > DEAD_TAP_MS) { unmetered = true; continue }
        if (best && best.level >= level) continue
        analyser.getFloatFrequencyData(spectrum)
        best = { level, brightness: brightness(spectrum, audio.sampleRate / analyser.fftSize) }
    }
    if (best && (best.level > 1e-4 || !unmetered)) return { state: 'level', ...best }
    return unmetered ? { state: 'unmetered' } : { state: 'silent' }
}
