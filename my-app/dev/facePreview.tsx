// Dev only harness for face-preview.html: mounts the real 3D boardroom with a fake room state, so the ten
// characters' speaking faces can be checked without a backend or a running game.
//
// A voice is any audio file: pass `?voice=<url>` (it is fetched into this page, so it must allow cross origin
// reads) or pick a file. It plays through the same meter the game uses (`game/voiceMeter.ts`), three ways:
// `blob` (a whole file, like a saved clip), `mse` (streamed through Media Source Extensions, like an AI reply) and
// `direct` (the URL itself; from another origin it cannot be analysed, which shows the procedural fallback).
// "Live microphone" marks the talker as talking with no audio at all, which is also procedural.
//
// Other parameters: `seats` (1 to 10), `talker` (seat index), `self` (seat index), `mode`.
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Boardroom3D from '../src/features/boardroom3d/Boardroom3D'
import { CHARACTER_IDS } from '../src/features/boardroom3d/assets'
import { boardroomView, type BoardMember, type StageAgent } from '../src/features/boardroom3d/boardroomModel'
import { meterVoice, readVoice } from '../src/features/game/voiceMeter'
import '../src/index.css'
import '../src/pages/Game.css'
import '../src/pages/GameTheme.css'

const COLORS = ['#4c7bd9', '#3aa37a', '#c9733a', '#9b5fd0', '#d05f7c', '#5fa9d0', '#b0a03a', '#6f7d8c', '#d0875f', '#4fb3a1']
const agent: StageAgent = { kind: 'expert', name: 'IT adviser', role: 'AI expert', accent: '#5aa9e6' }
const params = new URLSearchParams(location.search)
const numberParam = (name: string, fallback: number, max: number) => {
    const value = Number(params.get(name))
    return params.has(name) && Number.isInteger(value) && value >= 0 && value <= max ? value : fallback
}
type Mode = 'blob' | 'mse' | 'direct'
const MODES: Mode[] = ['blob', 'mse', 'direct']

/** An MP3 played while it is appended, the way `streamedSpeech` plays an AI reply. */
function streamedPlayer(bytes: ArrayBuffer): { player: HTMLAudioElement; dispose: () => void } {
    const source = new MediaSource()
    const url = URL.createObjectURL(source)
    const player = new Audio(url)
    source.addEventListener('sourceopen', () => {
        const buffer = source.addSourceBuffer('audio/mpeg')
        buffer.addEventListener('updateend', () => { if (source.readyState === 'open') source.endOfStream() }, { once: true })
        buffer.appendBuffer(bytes)
    }, { once: true })
    return { player, dispose: () => URL.revokeObjectURL(url) }
}

export function Preview() {
    const [seats, setSeats] = useState(Math.max(1, numberParam('seats', CHARACTER_IDS.length, CHARACTER_IDS.length)))
    const [talker, setTalker] = useState(numberParam('talker', 1, CHARACTER_IDS.length - 1))
    const [self, setSelf] = useState(numberParam('self', 0, CHARACTER_IDS.length - 1))
    const [mode, setMode] = useState<Mode>(MODES.includes(params.get('mode') as Mode) ? params.get('mode') as Mode : 'blob')
    const [voiceUrl, setVoiceUrl] = useState(params.get('voice') ?? '')
    const [bytes, setBytes] = useState<ArrayBuffer | null>(null)
    const [playing, setPlaying] = useState(false)
    const [microphone, setMicrophone] = useState(false)
    const [agentTalking, setAgentTalking] = useState(false)
    const [note, setNote] = useState('')
    const current = useRef<{ player: HTMLAudioElement; dispose: () => void } | null>(null)

    const members = useMemo<BoardMember[]>(() => CHARACTER_IDS.slice(0, seats).map((id, index) => (
        { id: `seat${index}`, name: id, role: `Seat ${index + 1}`, color: COLORS[index], connected: true }
    )), [seats])
    const talkerId = `seat${Math.min(talker, seats - 1)}`
    const talkingNow = (playing || microphone) && !agentTalking
    const view = useMemo(() => boardroomView({
        phase: 'speaking', selfId: `seat${Math.min(self, seats - 1)}`, eligibleIds: members.map((member) => member.id),
        activeSpeakerId: talkingNow ? talkerId : null, speakerIndex: 0, speakerCount: seats, scenarioTitle: 'Speaking faces preview',
    }, members, new Set(talkingNow ? [talkerId] : []), agentTalking ? agent : null), [members, self, seats, talkerId, talkingNow, agentTalking])
    const clock = useMemo(() => ({ deadline: null, serverTime: null }), [])

    useEffect(() => {
        if (!voiceUrl) return
        let cancelled = false
        fetch(voiceUrl).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.arrayBuffer()
        }).then((loaded) => { if (!cancelled) { setBytes(loaded); setNote(`Voice loaded (${Math.round(loaded.byteLength / 1024)} KB)`) } })
            .catch((failure: unknown) => { if (!cancelled) setNote(`Voice could not be fetched: ${failure instanceof Error ? failure.message : failure}`) })
        return () => { cancelled = true }
    }, [voiceUrl])

    const stop = useCallback(() => {
        current.current?.player.pause()
        current.current?.dispose()
        current.current = null
        setPlaying(false)
    }, [])

    const play = useCallback(() => {
        stop()
        let voice: { player: HTMLAudioElement; dispose: () => void }
        if (mode === 'direct') {
            if (!voiceUrl) { setNote('Direct mode needs ?voice=<url>'); return }
            voice = { player: new Audio(voiceUrl), dispose: () => undefined }
        } else {
            if (!bytes) { setNote('Load a voice first: ?voice=<url> or pick a file'); return }
            if (mode === 'mse') voice = streamedPlayer(bytes.slice(0))
            else {
                const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
                voice = { player: new Audio(url), dispose: () => URL.revokeObjectURL(url) }
            }
        }
        meterVoice(voice.player)
        current.current = voice
        voice.player.addEventListener('playing', () => setPlaying(true))
        voice.player.addEventListener('ended', () => { if (current.current === voice) stop() })
        voice.player.play().catch((failure: unknown) => { setNote(`Playback refused: ${failure instanceof Error ? failure.message : failure}`); stop() })
    }, [bytes, mode, stop, voiceUrl])

    // For automated checks: drive the page and read what the meter hears.
    useEffect(() => {
        const hooks = { play, stop, readVoice, setTalker, setSeats, setMode, setMicrophone, setAgentTalking, player: () => current.current?.player ?? null }
        ;(window as Window & { __facePreview?: typeof hooks }).__facePreview = hooks
    }, [play, stop])

    return <div className="game-call-screen game-live-screen" style={{ position: 'absolute', inset: 0, display: 'flex' }}>
        <main className="game-call-main game-live-main game-live-main--3d" style={{ flex: 1, height: '100%', display: 'grid' }}>
            <Boardroom3D active view={view} clock={clock} />
        </main>
        <div id="panel">
            <h1>Speaking faces preview</h1>
            <label htmlFor="seats">Seats filled</label>
            <select id="seats" value={seats} onChange={(event) => setSeats(Number(event.target.value))}>
                {CHARACTER_IDS.map((_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
            </select>
            <label htmlFor="talker">Who talks</label>
            <select id="talker" value={Math.min(talker, seats - 1)} onChange={(event) => setTalker(Number(event.target.value))}>
                {members.map((member, index) => <option key={member.id} value={index}>{`Seat ${index + 1}: ${member.name}`}</option>)}
            </select>
            <label htmlFor="self">You are</label>
            <select id="self" value={Math.min(self, seats - 1)} onChange={(event) => setSelf(Number(event.target.value))}>
                {members.map((member, index) => <option key={member.id} value={index}>{`Seat ${index + 1}: ${member.name}`}</option>)}
            </select>
            <label htmlFor="mode">Voice plays as</label>
            <select id="mode" value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
                <option value="blob">a whole file (saved clip)</option>
                <option value="mse">a stream (AI reply)</option>
                <option value="direct">the URL itself</option>
            </select>
            <label htmlFor="voice">Voice file</label>
            <input id="voice" type="file" accept="audio/*" onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void file.arrayBuffer().then((loaded) => { setBytes(loaded); setVoiceUrl(''); setNote(`Voice loaded (${file.name})`) })
            }} />
            <button type="button" id="play" onClick={playing ? stop : play}>{playing ? 'Stop the voice' : 'Play the voice'}</button>
            <button type="button" id="microphone" onClick={() => setMicrophone(!microphone)}>{microphone ? 'Stop the live microphone' : 'Live microphone (no audio)'}</button>
            <button type="button" id="agent" onClick={() => setAgentTalking(!agentTalking)}>{agentTalking ? 'Agent stops' : 'AI agent talks at the hub'}</button>
            <p id="note">{note}</p>
            <p>Dev only page: the real 3D scene with a fake room state, no backend. Only the chosen talker's mouth should move, with the loudness of the voice, and stop when it ends.</p>
        </div>
    </div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>)
