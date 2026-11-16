// The speaking face of the 3D boardroom characters, as morph target weights.
// All ten character GLBs carry the same face rig: `Blink_L`, `Blink_R`, `Smile`, `Frown`, `BrowRaise`, `MouthOpen`
// and `MouthRound` on the face mesh, with `MouthOpen` and `MouthRound` again on a separate mouth interior mesh
// (the dark cavity behind the lips), which must move with the face. One driver therefore serves every character.
// This module is pure so it can be unit tested without three.js; the audio side is in `game/voiceMeter.ts`.

export const FACE_MORPHS = ['Blink_L', 'Blink_R', 'Smile', 'Frown', 'BrowRaise', 'MouthOpen', 'MouthRound'] as const
export type FaceMorph = (typeof FACE_MORPHS)[number]
export type FaceWeights = Record<FaceMorph, number>

/**
 * What the scene hears of the talker's voice this frame: `level` is the loudness (RMS, 0 to about 0.4 for speech)
 * and `brightness` runs from 0 for dark, rounded sounds (oo, oh) to 1 for bright, spread ones (ee, s).
 */
export type VoiceSample = { level: number; brightness: number }

/** What a character's face reacts to; built by the scene each frame. */
export type FaceContext = {
    /** This member is talking now (their voice clip, AI reply, microphone or dictation). */
    talking: boolean
    /** Their voice as analysed from the playing audio, or null when it cannot be heard here (then the mouth is procedural). */
    voice: VoiceSample | null
}

export const neutralFace = (): FaceWeights => ({ Blink_L: 0, Blink_R: 0, Smile: 0, Frown: 0, BrowRaise: 0, MouthOpen: 0, MouthRound: 0 })

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const smoothstep = (edge0: number, edge1: number, x: number) => {
    const t = clamp01((x - edge0) / (edge1 - edge0))
    return t * t * (3 - 2 * t)
}

/** The most the mouth opens while speaking: a moderate, conversational opening, never a wide one (no teeth on show). */
export const SPEECH_MOUTH_MAX = 0.32
/** The most a brow accent adds while speaking. */
export const SPEECH_BROW_MAX = 0.2
/** The most the lips round (for oo and oh sounds) while speaking. */
export const SPEECH_ROUND_MAX = 0.6
/** The warm base smile of a talking face; the wide (ee) mouth shape and a slow swell are added to it. */
const SPEECH_SMILE_BASE = 0.2

/** Loudness below this is room tone or a pause: the mouth stays shut. */
export const VOICE_GATE = 0.012
/** Loudness at which the mouth reaches its full speaking opening. */
export const VOICE_FULL = 0.16

/**
 * Mouth opening for a voice loudness: closed below the gate, then rising quickly so quiet syllables still show,
 * up to SPEECH_MOUTH_MAX. This is amplitude lip sync, not phoneme lip sync.
 */
export function voiceMouth(level: number): number {
    const open = clamp01((level - VOICE_GATE) / (VOICE_FULL - VOICE_GATE))
    return SPEECH_MOUTH_MAX * open ** 0.6
}

/**
 * Procedural speech mouth, for a talker whose audio cannot be analysed in this window (a live microphone, or a
 * browser without media capture): syllables at about 4 to 5 per second, louder and quieter stretches, and short
 * pauses between phrases. `seed` keeps characters out of step. Returns 0 to SPEECH_MOUTH_MAX.
 */
export function speechMouth(time: number, seed: number): number {
    const syllable = Math.abs(Math.sin(time * 14.2 + seed)) * (0.65 + 0.35 * Math.sin(time * 3.7 + seed * 1.7))
    const loudness = 0.75 + 0.25 * Math.sin(time * 1.3 + seed * 2.3)
    const phrase = smoothstep(-0.55, -0.15, Math.sin(time * 0.85 + seed * 3.1))
    return Math.min(SPEECH_MOUTH_MAX, 0.01 + (SPEECH_MOUTH_MAX - 0.01) * syllable * loudness * phrase)
}

/** Procedural stand in for the voice's brightness, drifting between rounded and spread mouth shapes: 0 to 1. */
export function speechBrightness(time: number, seed: number): number {
    return 0.5 + 0.5 * Math.sin(time * 2.9 + seed * 1.9) * Math.cos(time * 1.1 + seed)
}

/** Brow lifts that accent speech every couple of seconds. Returns 0 to SPEECH_BROW_MAX. */
export function speechBrow(time: number, seed: number): number {
    return SPEECH_BROW_MAX * Math.max(0, Math.sin(time * 1.7 + seed * 1.3)) ** 3
}

/** How much the smile swells and settles while speaking, so the face stays alive: -0.1 to 0.12. */
export function speechSmile(time: number, seed: number): number {
    return 0.11 * Math.sin(time * 0.9 + seed * 0.7) + 0.01 * Math.sin(time * 2.3 + seed)
}

/**
 * Subtle head movement while speaking, in radians: a slow nod (`pitch`, positive lifts the face) and a small
 * side to side turn (`yaw`), each within about one degree and a half. `amount` (0 to 1) fades it in and out.
 */
export function speechHead(time: number, seed: number, amount: number): { pitch: number; yaw: number } {
    return {
        pitch: amount * (0.022 * Math.sin(time * 2.4 + seed) + 0.01 * Math.sin(time * 5.3 + seed * 2.1)),
        yaw: amount * 0.026 * Math.sin(time * 1.3 + seed * 0.6),
    }
}

const BLINK = { close: 0.07, hold: 0.04, open: 0.13 }

/**
 * Natural blinking: a blink every 2 to 6 seconds (a little more often while talking), with an
 * occasional double blink. `random` is injectable so tests are deterministic.
 */
export class Blinker {
    private wait: number
    private phase = -1 // seconds into the current blink, or -1 between blinks
    private pending = 0 // extra blinks queued (double blink)
    private readonly random: () => number

    constructor(random: () => number = Math.random) {
        this.random = random
        this.wait = 0.5 + this.random() * 3
    }

    /** Advance by dt seconds and return how closed the eyes are, 0 to 1. */
    update(dt: number, talking = false): number {
        if (this.phase < 0) {
            this.wait -= dt
            if (this.wait > 0) return 0
            this.phase = 0
        } else {
            this.phase += dt
        }
        const { close, hold, open } = BLINK
        const t = this.phase
        if (t < close) return t / close
        if (t < close + hold) return 1
        if (t < close + hold + open) return 1 - (t - close - hold) / open
        // Blink finished: schedule the next one.
        this.phase = -1
        if (this.pending > 0) {
            this.pending -= 1
            this.wait = 0.12
        } else {
            if (this.random() < 0.12) this.pending = 1
            this.wait = (talking ? 1.6 : 2) + this.random() * (talking ? 3 : 4)
        }
        return 0
    }
}

/** Ease a weight toward its target at `rate` per second, frame rate independent. */
export function approach(current: number, target: number, rate: number, dt: number): number {
    return target + (current - target) * Math.exp(-rate * dt)
}

/**
 * One frame of a character's face. While talking, the mouth follows the voice (or the procedural syllables when
 * the voice cannot be analysed), its shape leans rounded or spread with the sound, and a warm smile and brow
 * accents keep the face alive. When the talk stops everything eases back to rest; only the blink continues.
 * `state` holds the eased values between frames.
 */
export function faceFrame(state: FaceWeights, context: FaceContext, blink: number, time: number, seed: number, dt: number): FaceWeights {
    const { talking, voice } = context
    const mouthTarget = !talking ? 0 : voice ? voiceMouth(voice.level) : speechMouth(time, seed)
    // Open quickly on a syllable, close a little slower, and close gently when speech stops.
    const opening = mouthTarget > state.MouthOpen
    state.MouthOpen = approach(state.MouthOpen, mouthTarget, talking ? (opening ? 26 : 14) : 8, dt)
    const open = clamp01(state.MouthOpen / SPEECH_MOUTH_MAX)
    const brightness = clamp01(voice ? voice.brightness : speechBrightness(time, seed))
    // Rounded lips for dark sounds and a wider mouth for bright ones, both only as far as the mouth is open.
    state.MouthRound = approach(state.MouthRound, talking ? SPEECH_ROUND_MAX * open * (1 - smoothstep(0.25, 0.6, brightness)) : 0, 10, dt)
    const wide = 0.14 * open * smoothstep(0.45, 0.85, brightness)
    state.Smile = approach(state.Smile, talking ? SPEECH_SMILE_BASE + wide : 0, talking ? 6 : 3, dt)
    state.BrowRaise = approach(state.BrowRaise, talking ? 0.08 : 0, 3, dt)
    state.Frown = approach(state.Frown, 0, 3, dt)
    const out: FaceWeights = { ...state }
    if (talking) {
        out.BrowRaise = clamp01(out.BrowRaise + speechBrow(time, seed))
        // A rounded mouth and a smile pull the corners opposite ways, so the smile gives way while the lips round.
        out.Smile = clamp01((out.Smile + speechSmile(time, seed)) * (1 - 0.7 * state.MouthRound / SPEECH_ROUND_MAX))
    }
    out.Blink_L = blink
    out.Blink_R = blink
    return out
}
