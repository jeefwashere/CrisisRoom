import test from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_SEATS, STAGE_STORAGE_KEY, boardMembers, boardroomView, offersStageSwitch, screenSubtitle, stagePreference, viewFromSearch } from '../src/features/boardroom3d/boardroomModel.ts'
import type { BoardMember, BoardroomInput, StageAgent } from '../src/features/boardroom3d/boardroomModel.ts'
import { DEMO_VIEW_KEY, readDemoView, soloFrameLeftGame, soloFrameSrc } from '../src/features/demo/demoModel.ts'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const member = (id: string, name: string): BoardMember => ({ id, name, role: `${name} role`, color: '#123456', connected: true })
const alex = member('a', 'Alex')
const morgan = member('m', 'Morgan')
const sam = member('s', 'Sam')
const input = (fields: Partial<BoardroomInput> = {}): BoardroomInput => ({
    phase: 'speaking', selfId: 'a', eligibleIds: ['a', 'm', 's'], activeSpeakerId: null, speakerIndex: null, speakerCount: 9, scenarioTitle: 'Cedar Bridge', ...fields,
})
const coach: StageAgent = { kind: 'coach', name: 'Crisis coach', role: 'AI crisis coach · private', accent: null }

test('seats follow the electorate order and stop at ten', () => {
    const extra = member('x', 'Extra')
    assert.equal(BOARD_SEATS, 10)
    assert.deepEqual(boardMembers([sam, extra, morgan, alex], ['a', 'm', 's']).map((seat) => seat.id), ['a', 'm', 's', 'x'])
    const crowd = Array.from({ length: 12 }, (_, index) => member(`c${index}`, `Member ${index}`))
    assert.equal(boardMembers(crowd, []).length, 10)
    assert.deepEqual(boardMembers([extra, morgan], ['a', 'm']).map((seat) => seat.id), ['m', 'x'])
})

test('the talking member animates and the camera presents them', () => {
    const view = boardroomView(input({ activeSpeakerId: 'm', speakerIndex: 1 }), [alex, morgan, sam], new Set(['m']), null)
    assert.equal(view.focusId, 'm')
    assert.deepEqual(view.seats.map((seat) => seat.mood), ['sit', 'talk', 'sit'])
    assert.equal(view.seats[0].isSelf, true)
    assert.equal(view.screen.subtitle, 'Turn 2 of 9')
    assert.equal(view.agentPresent, false)
})

test('your own turn keeps the camera on you before your clip plays', () => {
    const view = boardroomView(input({ activeSpeakerId: 'a', speakerIndex: 0 }), [alex, morgan, sam], new Set(), null)
    assert.equal(view.focusId, 'a')
    assert.equal(view.seats[0].mood, 'sit')
})

test('an agent speaking takes the camera to the hub', () => {
    const view = boardroomView(input({ phase: 'private_session' }), [alex, morgan, sam], new Set(), coach)
    assert.equal(view.focusId, null)
    assert.equal(view.agent, coach)
    assert.equal(view.agentPresent, true)
    // Nobody types: the others sit with their hands on the table.
    assert.deepEqual(view.seats.map((seat) => seat.mood), ['sit', 'sit', 'sit'])
})

test('agent phases keep the hub present between lines; decisions keep everyone seated', () => {
    assert.equal(boardroomView(input({ phase: 'briefing' }), [alex], new Set(), null).agentPresent, true)
    assert.equal(boardroomView(input({ phase: 'discussion' }), [alex], new Set(), null).agentPresent, true)
    const deciding = boardroomView(input({ phase: 'individual_decision' }), [alex, morgan, sam], new Set(), null)
    assert.equal(deciding.agentPresent, false)
    assert.deepEqual(deciding.seats.map((seat) => seat.mood), ['sit', 'sit', 'sit'])
    assert.equal(deciding.focusId, null)
})

test('wall screen subtitles name the phase without any spoken text', () => {
    assert.equal(screenSubtitle({ phase: 'speaking', speakerIndex: null, speakerCount: 9 }), 'Speaking turns')
    assert.equal(screenSubtitle({ phase: 'discussion', speakerIndex: null, speakerCount: 0 }), 'Expert panel')
    assert.equal(screenSubtitle({ phase: 'some_new_phase', speakerIndex: null, speakerCount: 0 }), 'some new phase')
})

test('view and demo stage choices', () => {
    assert.equal(viewFromSearch('?seat=alex&view=3d'), '3d')
    assert.equal(viewFromSearch('?view=call'), 'call')
    assert.equal(viewFromSearch('?view=vr'), null)
    assert.equal(readDemoView(null), '3d')
    assert.equal(readDemoView('call'), 'call')
    const id = '123e4567-e89b-12d3-a456-426614174000'
    assert.equal(soloFrameSrc('/', id, '3d'), `/?seat=alex&view=3d#/room/${id}`)
    assert.equal(soloFrameSrc('/', id, 'call'), `/?seat=alex#/room/${id}`)
})

test('the judge demo returns to its start screen only when the frame leaves its game', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000'
    // In the game, including the ended screen and the summary preview, which keep the room address.
    assert.equal(soloFrameLeftGame(`#/room/${id}`), false)
    assert.equal(soloFrameLeftGame(`#/room/${id}?preview=summary`), false)
    // Leave room sends the frame home; the home page's Judge Demo button sends it to #/demo.
    assert.equal(soloFrameLeftGame('#/'), true)
    assert.equal(soloFrameLeftGame(''), true)
    assert.equal(soloFrameLeftGame('#/demo'), true)
    assert.equal(soloFrameLeftGame('#/host'), true)
})

test('the stage switch remembers the tab choice over the URL and offers 3D for up to ten seats', () => {
    assert.equal(stagePreference(null, '?view=3d'), '3d')
    assert.equal(stagePreference(null, ''), 'call')
    assert.equal(stagePreference('call', '?view=3d'), 'call')
    assert.equal(stagePreference('3d', ''), '3d')
    assert.equal(stagePreference('bogus', '?view=call'), 'call')
    // The demo setup and the in game switch share one choice.
    assert.equal(DEMO_VIEW_KEY, STAGE_STORAGE_KEY)
    assert.equal(offersStageSwitch(3), true)
    assert.equal(offersStageSwitch(1), true)
    assert.equal(offersStageSwitch(0), false)
    assert.equal(offersStageSwitch(10), true)
    assert.equal(offersStageSwitch(11), false)
})

// The model files as shipped. They are compressed by tools/optimize-models.mjs; these checks fail if a later
// processing step drops part of the speaking rig or leaves a manifest pointing at a missing file.
type GltfJson = {
    extensionsUsed?: string[]
    nodes: { name?: string }[]
    skins?: { joints: number[] }[]
    meshes?: { name?: string; extras?: { targetNames?: string[] }; primitives: { attributes: Record<string, number>; targets?: unknown[] }[] }[]
    materials?: { name?: string }[]
    animations?: { name?: string; channels: unknown[] }[]
}
const models = new URL('../public/models/', import.meta.url)
function gltfJson(file: string): GltfJson {
    const bytes = readFileSync(new URL(file, models))
    assert.equal(bytes.toString('latin1', 0, 4), 'glTF', file)
    return JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as GltfJson
}

test('every character file keeps the shared skeleton and the speaking rig', () => {
    const files = readdirSync(new URL('characters/', models)).filter((name) => /^\d\d-.*\.glb$/.test(name)).sort()
    assert.equal(files.length, BOARD_SEATS)
    const faceTargets = ['Blink_L', 'Blink_R', 'Smile', 'Frown', 'BrowRaise', 'MouthOpen', 'MouthRound']
    let skeleton: string[] | null = null
    for (const file of files) {
        const gltf = gltfJson(`characters/${file}`)
        assert.equal(gltf.skins?.length, 1, `${file}: one skin shared by the face and the mouth interior`)
        const joints = gltf.skins![0].joints.map((index) => gltf.nodes[index].name ?? '')
        assert.equal(joints.length, 65, file)
        skeleton ??= joints
        assert.deepEqual(joints, skeleton, `${file}: same joint names in the same order as the first character`)
        const meshes = gltf.meshes ?? []
        const interior = meshes.find((mesh) => mesh.name?.endsWith('_mouth_interior'))
        const face = meshes.find((mesh) => mesh !== interior)
        assert.deepEqual(face?.extras?.targetNames, faceTargets, file)
        assert.deepEqual(interior?.extras?.targetNames, ['MouthOpen', 'MouthRound'], file)
        for (const mesh of [face!, interior!]) {
            assert.equal(mesh.primitives.length, 1, file)
            assert.equal(mesh.primitives[0].targets?.length, mesh.extras?.targetNames?.length, file)
            assert.ok('JOINTS_0' in mesh.primitives[0].attributes && 'WEIGHTS_0' in mesh.primitives[0].attributes, `${file}: skin weights`)
        }
        assert.ok(gltf.materials?.some((material) => material.name === 'mouth_cavity'), `${file}: mouth_cavity material`)
    }
})

test('the animation library and the manifests match the files on disk', () => {
    const library = gltfJson('characters/animations.glb')
    assert.deepEqual(library.animations?.map((clip) => clip.name).sort(), ['disbelief', 'sit', 'talk', 'typing'])
    for (const clip of library.animations ?? []) assert.equal(clip.channels.length, 195, clip.name)
    const props = JSON.parse(readFileSync(new URL('props/props.json', models), 'utf8')) as { models: { file: string; bytes: number }[] }
    for (const prop of props.models) assert.equal(readFileSync(new URL(`props/${prop.file}`, models)).length, prop.bytes, prop.file)
    const room = JSON.parse(readFileSync(new URL('room/room.json', models), 'utf8')) as { file: string; bytes: number; sky: { file: string } }
    assert.equal(readFileSync(new URL(`room/${room.file}`, models)).length, room.bytes)
    assert.ok(existsSync(new URL(`../${room.sky.file}`, models)), room.sky.file)
})
