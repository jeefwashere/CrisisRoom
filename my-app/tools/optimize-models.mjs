#!/usr/bin/env node
/**
 * Shrinks the 3D boardroom downloads without changing how they look (task X56).
 *
 *   node tools/optimize-models.mjs <originals>
 *
 * `<originals>` is a folder holding the untouched `models/` and `textures/` trees (for example the backup at
 * `facerig_test/backup/models-before-x56`). Results are written into `public/models` and `public/textures`.
 * The originals are never read from `public/`, so running this twice cannot compress a file twice.
 *
 * What it does, with the glTF Transform command line tool fetched through npx (nothing is added to package.json):
 *
 * 1. Characters: mesh quantization plus meshopt compression. Positions keep 16 bits over the whole character
 *    (about 0.03 mm), one shared quantization grid so the face and the mouth interior keep one skin of 65 joints.
 *    Morph targets, their names, skin weights, material names and the JPEG texture bytes are untouched.
 * 2. animations.glb: meshopt compression with its animation filters (rotations within 0.003 degrees, positions
 *    within 0.25 mm). Keyframes are not resampled: that moved rotations by up to 0.4 degrees and saved nothing.
 * 3. Room and props: mesh quantization plus meshopt. Only the textures that were stored far above the quality of
 *    the rest (the baked room atlases, the plant and the credenza) are re-encoded, as WebP at quality 84.
 * 4. The skyline panorama becomes WebP at quality 84 (needs `cwebp` or ImageMagick `magick` on the PATH).
 *
 * The scene must give GLTFLoader the meshopt decoder (`loader.setMeshoptDecoder`), which Boardroom.ts does.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = '@gltf-transform/cli@4.5.1'
const WEBP_QUALITY = '84'
/** Textures saved at JPEG quality 95 or as 4096 px bakes; everything else is already a small quality 75 JPEG. */
const WEBP_PROPS = new Set(['sculptural-plant.glb', 'credenza.glb'])

const source = process.argv[2] ? resolve(process.argv[2]) : null
if (!source || !existsSync(join(source, 'models'))) {
    console.error('Usage: node tools/optimize-models.mjs <folder with the original models/ and textures/>')
    process.exit(1)
}
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const work = mkdtempSync(join(tmpdir(), 'boardroom-models-'))

function extensions(file) {
    const bytes = readFileSync(file)
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'))
    return json.extensionsUsed ?? []
}

function transform(command, input, output, options = []) {
    execFileSync('npx', ['--yes', CLI, command, input, output, ...options], { stdio: ['ignore', 'ignore', 'inherit'] })
}

/** Runs the steps in order through temporary files and writes the last result to `output`. */
function pipeline(input, output, steps) {
    if (extensions(input).includes('EXT_meshopt_compression')) throw new Error(`${input} is already compressed; pass the untouched originals`)
    let current = input
    steps.forEach(([command, options], index) => {
        const next = join(work, `${index}-${basename(input)}`)
        transform(command, current, next, options)
        current = next
    })
    copyFileSync(current, output)
    const before = statSync(input).size
    const after = statSync(output).size
    console.log(`${basename(output).padEnd(34)} ${String(Math.round(before / 1024)).padStart(5)} KB -> ${String(Math.round(after / 1024)).padStart(5)} KB`)
    return after
}

const quantize = (texcoord) => ['--level', 'medium', '--quantize-position', '16', '--quantize-normal', '12', '--quantize-texcoord', texcoord, '--quantize-weight', '16']
const webp = ['webp', ['--quality', WEBP_QUALITY, '--effort', '6']]

try {
    const characters = join(source, 'models', 'characters')
    for (const file of readdirSync(characters).filter((name) => /^\d\d-.*\.glb$/.test(name)).sort()) {
        pipeline(join(characters, file), join(publicDir, 'models', 'characters', file), [['meshopt', [...quantize('14'), '--quantization-volume', 'scene']]])
    }
    pipeline(join(characters, 'animations.glb'), join(publicDir, 'models', 'characters', 'animations.glb'), [['meshopt', ['--level', 'high']]])

    const roomBytes = pipeline(join(source, 'models', 'room', 'room.glb'), join(publicDir, 'models', 'room', 'room.glb'), [webp, ['meshopt', quantize('16')]])

    const props = join(source, 'models', 'props')
    const propBytes = new Map()
    for (const file of readdirSync(props).filter((name) => name.endsWith('.glb')).sort()) {
        const steps = WEBP_PROPS.has(file) ? [webp, ['meshopt', quantize('14')]] : [['meshopt', quantize('14')]]
        propBytes.set(file, pipeline(join(props, file), join(publicDir, 'models', 'props', file), steps))
    }

    // The manifests record each file's size; keep them true.
    const propsJson = join(publicDir, 'models', 'props', 'props.json')
    const manifest = JSON.parse(readFileSync(propsJson, 'utf8'))
    for (const model of manifest.models) if (propBytes.has(model.file)) model.bytes = propBytes.get(model.file)
    manifest.optimized = 'tools/optimize-models.mjs: KHR_mesh_quantization, EXT_meshopt_compression, WebP for the plant and credenza textures'
    writeFileSync(propsJson, `${JSON.stringify(manifest, null, 1)}\n`)

    const sky = join(source, 'textures', 'sky', 'skyline.jpg')
    const skyOut = join(publicDir, 'textures', 'sky', 'skyline.webp')
    let skyDone = false
    if (existsSync(sky)) {
        for (const [tool, options] of [['cwebp', ['-quiet', '-q', WEBP_QUALITY, '-m', '6', sky, '-o', skyOut]], ['magick', [sky, '-quality', WEBP_QUALITY, '-define', 'webp:method=6', skyOut]]]) {
            try { execFileSync(tool, options, { stdio: 'ignore' }); skyDone = true; break } catch { /* try the next encoder */ }
        }
        if (skyDone) {
            rmSync(join(publicDir, 'textures', 'sky', 'skyline.jpg'), { force: true })
            console.log(`${'skyline.webp'.padEnd(34)} ${String(Math.round(statSync(sky).size / 1024)).padStart(5)} KB -> ${String(Math.round(statSync(skyOut).size / 1024)).padStart(5)} KB`)
        } else console.warn('skyline.jpg left as it is: neither cwebp nor magick is installed')
    }

    // room.json is edited as text so its hand written number formatting stays as it is.
    const roomJson = join(publicDir, 'models', 'room', 'room.json')
    let room = readFileSync(roomJson, 'utf8').replace(/("file": "room\.glb",\s*"bytes": )\d+/, `$1${roomBytes}`)
    if (skyDone) room = room.replace('"textures/sky/skyline.jpg"', '"textures/sky/skyline.webp"')
    writeFileSync(roomJson, room)
} finally {
    rmSync(work, { recursive: true, force: true })
}
