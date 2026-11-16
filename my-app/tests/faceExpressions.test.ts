import test from 'node:test'
import assert from 'node:assert/strict'
import {
    Blinker, FACE_MORPHS, SPEECH_BROW_MAX, SPEECH_MOUTH_MAX, SPEECH_ROUND_MAX, VOICE_FULL, VOICE_GATE, approach, faceFrame, neutralFace, speechBrow,
    speechHead, speechMouth, voiceMouth,
} from '../src/features/boardroom3d/faceExpressions.ts'
import type { FaceContext, VoiceSample } from '../src/features/boardroom3d/faceExpressions.ts'
import { brightness, rms } from '../src/features/game/voiceMeter.ts'

const context = (fields: Partial<FaceContext> = {}): FaceContext => ({ talking: false, voice: null, ...fields })
const voice = (level: number, bright = 0.5): VoiceSample => ({ level, brightness: bright })
/** Runs the face for `seconds` at 60 frames a second and returns the last frame. */
function settle(state: ReturnType<typeof neutralFace>, at: FaceContext, seconds = 2) {
    let frame = faceFrame(state, at, 0, 0, 1, 1 / 60)
    for (let i = 1; i < seconds * 60; i++) frame = faceFrame(state, at, 0, i / 60, 1, 1 / 60)
    return frame
}

test('the morph names match the face rigged character GLBs', () => {
    assert.deepEqual([...FACE_MORPHS], ['Blink_L', 'Blink_R', 'Smile', 'Frown', 'BrowRaise', 'MouthOpen', 'MouthRound'])
    assert.deepEqual(Object.keys(neutralFace()).sort(), [...FACE_MORPHS].sort())
})

test('the mouth follows the loudness of the voice, up to a moderate opening', () => {
    assert.equal(voiceMouth(0), 0)
    assert.equal(voiceMouth(VOICE_GATE), 0, 'room tone and pauses keep the mouth shut')
    assert.ok(voiceMouth(0.04) > 0.1, 'a quiet syllable still shows')
    assert.ok(voiceMouth(0.08) > voiceMouth(0.04))
    assert.equal(voiceMouth(VOICE_FULL), SPEECH_MOUTH_MAX)
    assert.equal(voiceMouth(0.9), SPEECH_MOUTH_MAX, 'a shout opens no wider')
    assert.ok(SPEECH_MOUTH_MAX <= 0.35, 'never a wide open mouth')
})

test('a talker with an analysed voice opens on sound and closes in the pauses', () => {
    const state = neutralFace()
    const loud = settle(state, context({ talking: true, voice: voice(0.2) }), 1)
    assert.ok(loud.MouthOpen > 0.3 && loud.MouthOpen <= SPEECH_MOUTH_MAX, `open on a loud syllable (${loud.MouthOpen})`)
    const pause = settle(state, context({ talking: true, voice: voice(0) }), 1)
    assert.ok(pause.MouthOpen < 0.01, `shut in a pause (${pause.MouthOpen})`)
    // It opens faster than it closes, and neither jumps.
    const opening = faceFrame(state, context({ talking: true, voice: voice(0.2) }), 0, 0, 1, 1 / 60)
    assert.ok(opening.MouthOpen > 0.05 && opening.MouthOpen < SPEECH_MOUTH_MAX)
})

test('only the talker moves: a listener keeps a still, neutral face whatever is playing', () => {
    const state = neutralFace()
    const frame = settle(state, context({ talking: false, voice: voice(0.3, 0.9) }))
    assert.deepEqual(frame, neutralFace())
})

test('the face returns to rest when the talk stops', () => {
    const state = neutralFace()
    const talking = settle(state, context({ talking: true, voice: voice(0.2, 0.1) }), 1)
    assert.ok(talking.MouthOpen > 0.3 && talking.Smile > 0 && talking.MouthRound > 0)
    const rest = settle(state, context({ talking: false }), 3)
    for (const morph of FACE_MORPHS) assert.ok(Math.abs(rest[morph]) < 0.005, `${morph} at rest (${rest[morph]})`)
})

test('dark sounds round the lips and bright sounds spread them', () => {
    const dark = settle(neutralFace(), context({ talking: true, voice: voice(0.2, 0) }), 1)
    const bright = settle(neutralFace(), context({ talking: true, voice: voice(0.2, 1) }), 1)
    assert.ok(dark.MouthRound > 0.5 && dark.MouthRound <= SPEECH_ROUND_MAX, `rounded (${dark.MouthRound})`)
    assert.ok(bright.MouthRound < 0.02, `not rounded (${bright.MouthRound})`)
    assert.ok(bright.Smile > dark.Smile, 'a bright sound widens the mouth')
    // The lips only round as far as the mouth is open.
    const quiet = settle(neutralFace(), context({ talking: true, voice: voice(0, 0) }), 1)
    assert.ok(quiet.MouthRound < 0.02)
})

test('without an analysed voice the talker gets the procedural mouth', () => {
    assert.ok(SPEECH_MOUTH_MAX <= 0.35)
    let min = 1, max = 0
    for (let t = 0; t < 20; t += 1 / 60) {
        const open = speechMouth(t, 3.3)
        assert.ok(open >= 0 && open <= SPEECH_MOUTH_MAX)
        min = Math.min(min, open); max = Math.max(max, open)
        assert.ok(speechBrow(t, 3.3) >= 0 && speechBrow(t, 3.3) <= SPEECH_BROW_MAX)
    }
    assert.ok(min < 0.03, `mouth closes between syllables and phrases (min ${min})`)
    assert.ok(max > 0.25, `the mouth visibly opens on syllables (max ${max})`)
    // Different seeds keep characters out of step.
    let difference = 0
    for (let t = 0; t < 5; t += 0.1) difference += Math.abs(speechMouth(t, 1) - speechMouth(t, 50))
    assert.ok(difference > 0.4)
    const state = neutralFace()
    let opened = 0
    for (let i = 0; i < 300; i++) opened = Math.max(opened, faceFrame(state, context({ talking: true }), 0, i / 60, 1, 1 / 60).MouthOpen)
    assert.ok(opened > 0.2 && opened <= SPEECH_MOUTH_MAX)
})

test('the speaking face stays alive and moderate: a warm smile, brow accents, no grin', () => {
    const state = neutralFace()
    let smileMax = 0, browMax = 0
    for (let i = 0; i < 600; i++) {
        const frame = faceFrame(state, context({ talking: true, voice: voice(0.1 + 0.1 * Math.sin(i / 4)) }), 0, i / 60, 2, 1 / 60)
        smileMax = Math.max(smileMax, frame.Smile); browMax = Math.max(browMax, frame.BrowRaise)
        assert.equal(frame.Frown, 0)
    }
    assert.ok(smileMax > 0.15 && smileMax <= 0.5, `a smile, never a grin (${smileMax})`)
    assert.ok(browMax > 0.15 && browMax <= 0.3, `brows lift (${browMax})`)
})

test('the head moves a little while speaking and not at all at rest', () => {
    const still = speechHead(3, 1, 0)
    assert.ok(still.pitch === 0 && still.yaw === 0)
    let pitch = 0, yaw = 0
    for (let t = 0; t < 10; t += 1 / 30) {
        const head = speechHead(t, 1, 1)
        pitch = Math.max(pitch, Math.abs(head.pitch)); yaw = Math.max(yaw, Math.abs(head.yaw))
    }
    // Visible but subtle: between half a degree and two degrees.
    for (const angle of [pitch, yaw]) assert.ok(angle > 0.009 && angle < 0.035, `${angle} rad`)
})

test('blinks close the eyes fully, then reopen, every few seconds', () => {
    const blinker = new Blinker(() => 0.5)
    const dt = 1 / 60
    const values: number[] = []
    for (let t = 0; t < 20; t += dt) values.push(blinker.update(dt))
    const closures = values.filter((v, i) => v === 1 && values[i - 1] !== 1).length
    assert.ok(closures >= 3 && closures <= 8, `about one blink every 2 to 6 seconds (got ${closures} in 20 s)`)
    assert.ok(values.every((v) => v >= 0 && v <= 1))
    assert.ok(values.filter((v) => v > 0).length / values.length < 0.15, 'eyes are open most of the time')
    const frame = faceFrame(neutralFace(), context(), 0.7, 5, 1, 1 / 60)
    assert.equal(frame.Blink_L, 0.7)
    assert.equal(frame.Blink_R, 0.7)
    assert.equal(approach(1, 0, 5, 0), 1)
})

test('loudness is the RMS of the samples', () => {
    assert.equal(rms([]), 0)
    assert.equal(rms([0, 0, 0, 0]), 0)
    assert.ok(Math.abs(rms([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9)
    assert.ok(Math.abs(rms(Array.from({ length: 480 }, (_, i) => 0.3 * Math.sin(i / 5))) - 0.3 / Math.SQRT2) < 0.01)
})

test('brightness reads where the energy sits between 250 Hz and 4 kHz', () => {
    const binHz = 46.875 // 48 kHz with an FFT of 1024
    const spectrum = (peakHz: number) => Array.from({ length: 512 }, (_, bin) => Math.abs(bin * binHz - peakHz) < 150 ? -20 : -100)
    assert.ok(brightness(spectrum(450), binHz) < 0.05, 'a low vowel like oo is dark')
    assert.ok(brightness(spectrum(2600), binHz) > 0.95, 'a spread vowel like ee is bright')
    const middle = brightness(spectrum(1200), binHz)
    assert.ok(middle > 0.3 && middle < 0.7)
    assert.equal(brightness(Array.from({ length: 512 }, () => -Infinity), binHz), 0.5, 'silence is neutral')
})
