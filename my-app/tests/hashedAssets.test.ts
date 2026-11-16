import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HASH_LENGTH, hashedAssetFiles, hashedName } from '../tools/hashedAssets.ts'

const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
const nginx = readFileSync(new URL('../../deploy/nginx.conf', import.meta.url), 'utf8')

/** The regex locations for the 3D files in deploy/nginx.conf, in file order (nginx uses the first that matches). */
const locations = [...nginx.matchAll(/location ~ "?(\^\/\(models\|textures\)\/[^"\s]*)"? \{\s*try_files \$uri =404;\s*add_header Cache-Control ([^;]+);/g)]
    .map(([, pattern, cacheControl]) => ({ pattern: new RegExp(pattern), cacheControl }))
const cacheControl = (path: string) => locations.find(({ pattern }) => pattern.test(`/${path}`))?.cacheControl

/** Every file the scene can ask for: what assets.ts and Boardroom.ts build from the folders and the two manifests. */
function requestedFiles(): string[] {
    const read = (path: string) => JSON.parse(readFileSync(new URL(path, new URL('../public/', import.meta.url)), 'utf8'))
    const props = read('models/props/props.json') as { models: { file: string }[] }
    const room = read('models/room/room.json') as { file: string; sky: { file: string } }
    return [
        ...readdirSync(new URL('../public/models/characters/', import.meta.url)).filter((name) => name.endsWith('.glb')).map((name) => `models/characters/${name}`),
        'models/props/props.json',
        ...props.models.map((prop) => `models/props/${prop.file.split('/').pop()}`),
        'models/room/room.json',
        `models/room/${room.file}`,
        room.sky.file.includes('public/') ? room.sky.file.split('public/')[1] : room.sky.file.replace(/^\//, ''),
    ]
}

test('every 3D file gets a hashed copy that the server lets browsers keep', () => {
    assert.equal(locations.length, 2, 'deploy/nginx.conf: one location for the hashed copies, one for the plain names')
    const files = hashedAssetFiles(publicDir)
    const requested = requestedFiles()
    assert.ok(requested.length >= 25, `${requested.length} files`)
    for (const path of requested) {
        const copy = files.get(path)
        assert.ok(copy, `${path}: no hashed copy, so it would be checked with the server on every visit`)
        assert.match(copy.name, new RegExp(`\\.[0-9a-f]{${HASH_LENGTH}}\\.[a-z0-9]+$`), path)
        assert.equal(copy.name.split('.').pop(), path.split('.').pop(), `${path}: same extension, so the same content type`)
        assert.match(cacheControl(copy.name) ?? '', /max-age=31536000, immutable/, copy.name)
        assert.equal(cacheControl(path), 'no-cache', `${path}: the plain name can change its bytes`)
    }
})

test('a hashed name changes when the bytes change, and only then', () => {
    const bytes = readFileSync(new URL('../public/models/characters/01-coo.glb', import.meta.url))
    const name = hashedName('models/characters/01-coo.glb', bytes)
    assert.equal(hashedName('models/characters/01-coo.glb', Uint8Array.from(bytes)), name)
    const changed = Uint8Array.from(bytes)
    changed[changed.length - 1] ^= 1
    assert.notEqual(hashedName('models/characters/01-coo.glb', changed), name)
    assert.equal(hashedAssetFiles(publicDir).get('models/characters/01-coo.glb')?.name, name)
    assert.throws(() => hashedName('models/README', bytes))
})
