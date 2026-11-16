/**
 * Boardroom model downloads, shared and started early. The 3D scene only mounts when the game begins, so the lobby
 * and setup screens call `preloadBoardroomAssets()` to fetch every model while players are still joining; the scene
 * then parses bytes that are already in memory. No three.js is imported here, so importing this costs nothing; the
 * scene code itself is only fetched (as its own chunk) once a preload asks for it.
 */

export const MODELS = `${import.meta.env.BASE_URL}models/`

/**
 * Copies of the files under public/models and public/textures whose names carry a hash of their bytes, written by
 * the build (tools/hashedAssets.ts): path under public/ to the path of its copy. The server lets browsers keep those
 * copies for good, so a second visit asks for nothing. Missing in `npm run dev` and in tests, which use plain names.
 */
declare const __BOARDROOM_HASHED_ASSETS__: Record<string, string> | undefined
const HASHED: Record<string, string> = typeof __BOARDROOM_HASHED_ASSETS__ === 'undefined' ? {} : __BOARDROOM_HASHED_ASSETS__

/** The hashed copy of a model or texture URL, or the URL itself when the build wrote none. */
function hashedUrl(url: string): string {
    const base = import.meta.env.BASE_URL
    const copy = url.startsWith(base) ? HASHED[url.slice(base.length)] : undefined
    return copy ? `${base}${copy}` : url
}

/**
 * Fetches the hashed copy of `url`. A tab that was opened before a deploy can ask for a copy that is gone; it then
 * gets the file under its plain name, which the server always checks for freshness.
 */
async function fetchHashed(url: string, init?: RequestInit): Promise<Response> {
    const copy = hashedUrl(url)
    const response = await fetch(copy, init)
    return response.ok || copy === url ? response : fetch(url, init)
}
/** The ten seated characters, in seat fill order: the first member gets the first character, and so on (rooms hold 10). */
export const CHARACTER_IDS = [
    '01-coo', '03-cto', '06-head-of-communications', '02-cfo', '04-general-counsel',
    '05-head-of-hr', '07-marketing-director', '08-sales-manager', '09-operations-manager', '10-project-manager',
]
/** Props the scene places, matched by a word in their file name (see props.json). */
export const PROP_WORDS = ['table', 'chair', 'credenza', 'water-service', 'plant', 'clock', 'holo-hub', 'display', 'laptop', 'console'] as const
export type PropWord = (typeof PROP_WORDS)[number]

const downloads = new Map<string, Promise<ArrayBuffer>>()
/** Downloads still in flight that the picture needs first: the characters, their clips, the room and the skyline. */
const urgent = new Set<Promise<unknown>>()

async function urgentDone() {
    while (urgent.size > 0) await Promise.allSettled([...urgent])
}

/**
 * One download per URL for the page's lifetime; a failed one is forgotten so the next call retries. A `'low'`
 * download (the props) starts once the urgent ones have arrived, so on a slow link the people and the room are not
 * held back by the furniture; simple stand in furniture shows until then.
 */
export function fetchAsset(url: string, priority: 'auto' | 'low' = 'auto'): Promise<ArrayBuffer> {
    const known = downloads.get(url)
    if (known) return known
    const request = () => fetchHashed(url, { priority }).then((response) => {
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
        return response.arrayBuffer()
    })
    const download = priority === 'low' ? urgentDone().then(request) : request()
    if (priority !== 'low') {
        const settled = () => { urgent.delete(download) }
        urgent.add(download)
        download.then(settled, settled)
    }
    download.catch(() => downloads.delete(url))
    downloads.set(url, download)
    return download
}

type Manifest = { models: { file: string }[] }
let manifest: Promise<Manifest | null> | null = null

/** props.json, or null when it is missing (the scene keeps its simple stand-in furniture). */
export function propManifest(): Promise<Manifest | null> {
    manifest ??= fetchHashed(`${MODELS}props/props.json`)
        .then((response) => response.ok && response.headers.get('content-type')?.includes('json') ? response.json() as Promise<Manifest> : null)
        .catch(() => null)
    return manifest
}

export function propUrl(entries: Manifest['models'], word: string): string | null {
    const entry = entries.find((item) => item.file.toLowerCase().includes(word))
    return entry ? `${MODELS}props/${entry.file.split('/').pop()}` : null
}

export type SkyInfo = { file: string; u_facing_minus_x?: number; three_background_rotation_y_rad_suggested?: number }
export type RoomInfo = { sky?: string | SkyInfo; emissive_boost?: number }
let roomInfo: Promise<RoomInfo | null> | null = null

/** room.json, or null when it is missing (the scene keeps its placeholder room). */
export function roomManifest(): Promise<RoomInfo | null> {
    roomInfo ??= fetchHashed(`${MODELS}room/room.json`)
        .then((response) => response.ok && response.headers.get('content-type')?.includes('json') ? response.json() as Promise<RoomInfo> : null)
        .catch(() => null)
    return roomInfo
}

/** The skyline panorama named by room.json (a repository path or a path under public/), with its URL. */
export function roomSky(info: RoomInfo): (SkyInfo & { url: string }) | null {
    const sky: SkyInfo | null = typeof info.sky === 'string' ? { file: info.sky } : info.sky ?? null
    if (!sky) return null
    const relative = sky.file.includes('public/') ? sky.file.split('public/')[1] : sky.file.replace(/^\//, '')
    return { ...sky, url: `${import.meta.env.BASE_URL}${relative}` }
}

let started = false
const swallow = (download: Promise<unknown>) => { download.catch(() => undefined) }

/**
 * Starts the model downloads in parallel; safe to call from any screen and again as members join. Only the characters
 * for the first `seats` seats are fetched, so a three person game does not download all ten.
 */
export function preloadBoardroomAssets(seats = 3): void {
    if (typeof fetch === 'undefined') return
    for (const id of CHARACTER_IDS.slice(0, Math.max(0, Math.min(seats, CHARACTER_IDS.length)))) swallow(fetchAsset(`${MODELS}characters/${id}.glb`))
    if (started) return
    started = true
    swallow(fetchAsset(`${MODELS}characters/animations.glb`))
    swallow(fetchAsset(`${MODELS}room/room.glb`))
    void roomManifest().then((info) => {
        const sky = info && roomSky(info)
        if (sky) swallow(fetchAsset(sky.url))
    })
    void propManifest().then((found) => {
        if (!found) return
        for (const word of PROP_WORDS) {
            const url = propUrl(found.models, word)
            if (url) swallow(fetchAsset(url, 'low'))
        }
    })
    // The scene code (three.js, about 250 KB compressed) once the page is idle, so opening the 3D stage does not wait
    // for it to download and compile.
    const loadScene = () => { swallow(import('./Boardroom')) }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(loadScene, { timeout: 3000 })
    else setTimeout(loadScene, 300)
}
