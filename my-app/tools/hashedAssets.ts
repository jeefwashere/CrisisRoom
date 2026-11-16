/**
 * Build step that lets browsers keep the 3D boardroom files for good (task X58).
 *
 * Vite copies `public/` as it is, so `models/room/room.glb` keeps its name when its bytes change and can only be
 * served with `Cache-Control: no-cache`. This plugin also writes a copy of every file under `public/models` and
 * `public/textures` whose name carries a hash of its bytes (`models/room/room.3fa9c1d2e4b7.glb`), and gives the app
 * the list as `__BOARDROOM_HASHED_ASSETS__` (read in `src/features/boardroom3d/assets.ts`). `deploy/nginx.conf`
 * serves names of that shape as `immutable`; a file that changes gets a new name, so nothing stale is ever shown.
 *
 * Nothing is written into `public/` or `src/` and nothing has to be run by hand: the hashes come from whatever is
 * on disk when `npm run build` runs, so a character that was exported again (and passed through
 * `tools/optimize-models.mjs`) simply gets a new name in the next build. The plain names are still copied, for
 * tabs opened before a deploy and for direct links. In `npm run dev` the list is empty and plain names are used.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/** Folders under `public/` whose files get a hashed copy. */
export const HASHED_FOLDERS = ['models', 'textures']
/** Hex digits of the SHA-256 kept in the name; `deploy/nginx.conf` matches exactly this many. */
export const HASH_LENGTH = 12

/** `models/room/room.glb` with the hash of `bytes` before its extension. */
export function hashedName(path: string, bytes: Uint8Array): string {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH)
    const dot = path.lastIndexOf('.')
    if (dot <= path.lastIndexOf('/')) throw new Error(`${path} has no file extension, so it cannot take a hashed name`)
    return `${path.slice(0, dot)}.${hash}${path.slice(dot)}`
}

export type HashedAsset = { name: string; bytes: Uint8Array }

/** Every file in the hashed folders of `publicDir`: its path under `public/` (with `/`) and its hashed copy. */
export function hashedAssetFiles(publicDir: string): Map<string, HashedAsset> {
    const found = new Map<string, HashedAsset>()
    for (const folder of HASHED_FOLDERS) {
        let files: string[]
        try { files = readdirSync(join(publicDir, folder), { recursive: true, encoding: 'utf8' }) } catch { continue }
        for (const file of files.sort()) {
            const path = `${folder}/${file.split('\\').join('/')}`
            if (path.split('/').some((part) => part.startsWith('.'))) continue
            let bytes: Uint8Array
            try { bytes = readFileSync(join(publicDir, folder, file)) } catch { continue /* a folder */ }
            found.set(path, { name: hashedName(path, bytes), bytes })
        }
    }
    return found
}

const DEFAULT_PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public')

export function hashedAssets(publicDir = DEFAULT_PUBLIC): Plugin {
    let files = new Map<string, HashedAsset>()
    return {
        name: 'boardroom-hashed-assets',
        apply: 'build',
        config() {
            files = hashedAssetFiles(publicDir)
            const names = Object.fromEntries([...files].map(([path, { name }]) => [path, name]))
            return { define: { __BOARDROOM_HASHED_ASSETS__: JSON.stringify(names) } }
        },
        generateBundle() {
            // The bytes that were hashed are the bytes that are written, even if a file changes during the build.
            for (const { name, bytes } of files.values()) this.emitFile({ type: 'asset', fileName: name, source: bytes })
        },
    }
}
