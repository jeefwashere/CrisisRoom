/**
 * The 3D boardroom for the solo T01 demo: the baked room, the full size table, three seated
 * Mixamo characters (Alex, Morgan, Sam) and the table hub, which is where the AI agents speak.
 *
 * Ported from the standalone 3D UI (`game-ui/src/scene/Boardroom.ts` on `arjun/game-ui-3d`).
 * Characters share one skeleton, so the clips in animations.glb drive all of them. Props come
 * from public/models/props/props.json; simple geometry stands in until they load.
 *
 * The scene never shows spoken text (docs/ui-integration-3d.md): only who is talking, through
 * animation, the presenter camera, name tags and the hub light.
 */
import * as THREE from 'three/webgpu'
import { mrt, normalView, output, pass, vec3, vec4 } from 'three/tsl'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { CHARACTER_IDS, MODELS, fetchAsset, propManifest, propUrl, roomManifest, roomSky, type PropWord } from './assets'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { SeatTags } from './SeatTags'
import type { BoardMood, BoardroomView } from './boardroomModel'
import { Blinker, FACE_MORPHS, SPEECH_MOUTH_MAX, approach, faceFrame, neutralFace, speechHead, type FaceMorph, type VoiceSample } from './faceExpressions'
import { readVoice, type VoiceReading } from '../game/voiceMeter'

/** Alex (CEO), Morgan (IT recovery lead), Sam (communications lead), in seat order. */
export { CHARACTER_IDS }

type Mood = BoardMood | 'disbelief'

/** Wall screen clock: the phase deadline and the server time it was read at. */
export type SceneClock = { deadline: string | null; serverTime: string | null }

/** Whether `createImageBitmap` honours `imageOrientation` (the same browser test GLTFLoader makes for its textures). */
function bitmapsFlip(): boolean {
  if (typeof createImageBitmap !== 'function') return false
  const agent = navigator.userAgent
  const safari = /^((?!chrome|android).)*safari/i.test(agent) ? Number(/Version\/(\d+)/.exec(agent)?.[1] ?? 0) : null
  const firefox = Number(/Firefox\/(\d+)/.exec(agent)?.[1] ?? 0)
  return !(safari !== null && safari < 17) && !(firefox > 0 && firefox < 98)
}

/** Loading milestones as User Timing marks (`board3d:*`), so a profile or a test page can see where the time goes. */
function mark(name: string) {
  performance.mark(`board3d:${name}`)
}

const TABLE = { length: 4.2, width: 1.4, height: 0.76 }
const UP = new THREE.Vector3(0, 1, 0)
/**
 * Seat origin to table edge. The Mixamo seated clips put the shoulders about 5 cm in front of
 * the seat origin with 0.46 m arms, and the typing clip's hands land 0.35 m forward at desk
 * height, so the edge has to be close for hands to reach the tabletop.
 */
const EDGE_GAP = 0.27
/**
 * The left hand rests on the left thigh, under the table and out of the camera's sight (seat space: +X is
 * the character's left, +Z its front). LAP_ALONG is how far from hip to knee the wrist sits: the table edge
 * is above 0.6 of the way, so the hand and its fingers lie beneath the top. THIGH is the thigh's radius.
 */
const LAP_ALONG = 0.66
const THIGH = 0.07
/** How far the lap hand's fingers open from the clip's clasped pose toward the open bind pose: loosely curled. */
const FINGER_RELAX = 0.8
/** Clearance of a wrist (the hand bone) above the surface its hand lies on, and of a finger joint's centre (a finger's radius). */
const WRIST_CLEARANCE = 0.035
const FINGER_CLEARANCE = 0.009
/**
 * A computer mouse at every seat, between the laptop (17 cm either side of the seat's centre) and the voting
 * console (from 30 cm to the right): its centre in seat space and its size. Its body is half an ellipsoid.
 */
const MOUSE = { x: -0.24, z: EDGE_GAP + 0.25, halfWidth: 0.034, halfLength: 0.062, height: 0.04 }
/**
 * Which hand rests on the mouse: -1 the character's right, 1 the left, 0 neither. For now neither (X64): the hand on
 * the table looked wrong, so both hands rest on the lap, under the table and out of sight, and no mouse is put out.
 */
const MOUSE_SIDE = 0 as 1 | -1 | 0
/**
 * The hands are not drawn (X64): each hand bone is shrunk to a point at the wrist, which takes the fingers with it,
 * so no hand shows from any seat or camera. The arms still rest toward the lap, where the sleeves end under the table.
 * Set to 1 to draw the hands again.
 */
const HAND_SCALE = 0.001
/** Wrist of the mouse hand in seat space: behind the mouse and high enough for the palm to lie on its back. */
const MOUSE_WRIST = { x: MOUSE.x - 0.004, y: TABLE.height + 0.052, z: MOUSE.z - 0.112 }
/** How far the mouse hand's fingers open from the clip's clasped pose: partly curled, so they drape over the mouse. */
const MOUSE_FINGER_RELAX = 0.42
/** How much of the open hand's finger spread is taken out on the mouse, so the fingers lie together. */
const MOUSE_FINGER_GATHER = 1

/** Height of the mouse's surface above the tabletop at a point in seat space (0 beside it). */
function mouseTop(x: number, z: number): number {
  const cap = 1 - ((x - MOUSE.x) / MOUSE.halfWidth) ** 2 - ((z - MOUSE.z) / MOUSE.halfLength) ** 2
  return cap > 0 ? MOUSE.height * Math.sqrt(cap) : 0
}

interface Seat {
  position: THREE.Vector3
  yaw: number
}

/**
 * Ten seats round the full size table: one at each end and four down each side, 1 m apart.
 * They are listed in fill order, so small groups still spread out: the first member sits at the
 * head nearest the overview camera, the next two on opposite sides offset along the table (so
 * neither blocks the other's close up), then the far end, then the remaining side seats.
 */
function makeSeats(): Seat[] {
  const side = TABLE.width / 2 + EDGE_GAP
  const end = TABLE.length / 2 + EDGE_GAP
  const near = (x: number): Seat => ({ position: new THREE.Vector3(x, 0, side), yaw: Math.PI })
  const far = (x: number): Seat => ({ position: new THREE.Vector3(x, 0, -side), yaw: 0 })
  return [
    { position: new THREE.Vector3(end, 0, 0), yaw: -Math.PI / 2 },
    near(0.5), far(-0.5),
    { position: new THREE.Vector3(-end, 0, 0), yaw: Math.PI / 2 },
    near(-1.5), far(1.5), near(1.5), far(-1.5), near(-0.5), far(0.5),
  ]
}

/**
 * Characters whose blink shape keys have been reviewed. Every character carries the same face rig, but the
 * blink was built by hand only for these; on the others the automatic eyelids tear, so their eyes stay open.
 */
const BLINK_READY = new Set(['01-coo', '02-cfo', '03-cto', '08-sales-manager'])
/** How long a talker may stay silent at first before the mouth turns procedural (their clip is still loading). */
const VOICE_GRACE = 1.2
/** A closed mouth for a talker whose voice has stopped or not started yet. */
const QUIET_VOICE: VoiceSample = { level: 0, brightness: 0.5 }

/** Top of the holo hub model (0.13 m tall) at the centre of the table. */
const HUB_TOP = new THREE.Vector3(0, TABLE.height + 0.13, 0)
const AGENT_COLOR = '#f0a23a'

class Avatar {
  readonly group = new THREE.Group()
  model: THREE.Object3D | null = null
  mixer: THREE.AnimationMixer | null = null
  actions = new Map<Mood, THREE.AnimationAction>()
  head: THREE.Bone | null = null
  hips: THREE.Bone | null = null
  mood: Mood | null = null
  yaw = 0
  /** Eased up or down head correction (radians, positive lifts the face). */
  pitch = 0
  /** The face's forward direction in the head bone's local space, measured in the bind pose. */
  private faceAxis: THREE.Vector3 | null = null
  /** Every mesh slot for each face morph: the face mesh, and the mouth interior for the mouth shapes. */
  private morphs = new Map<FaceMorph, { influences: number[]; index: number }[]>()
  private face = neutralFace()
  private blinker = new Blinker()
  private blinks = false
  private readonly faceSeed = Math.random() * 100
  /** This member is talking now (set from the board view). */
  talking = false
  /** Seconds since this member started talking, and whether a voice has played for them since. */
  private talkingFor = 0
  private voiceHeard = false
  /** 0 to 1, eased: how actively the mouth is moving, which drives the small speaking head movement. */
  private speaking = 0

  readonly seat: Seat

  constructor(seat: Seat) {
    this.seat = seat
    this.group.position.copy(seat.position)
    this.group.rotation.y = seat.yaw
  }

  attach(gltf: GLTF, clips: THREE.AnimationClip[], characterId: string) {
    this.model = gltf.scene
    this.blinks = BLINK_READY.has(characterId)
    this.model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh
      if (mesh.isSkinnedMesh) {
        // The mouth interior is a dark cavity behind the lips: it stays matte and unlit by the room's reflections.
        const cavity = (mesh.material as THREE.Material | undefined)?.name === 'mouth_cavity'
        mesh.castShadow = !cavity
        mesh.receiveShadow = true
        mesh.frustumCulled = false
        tuneMaterial(mesh.material as THREE.MeshStandardMaterial, cavity ? { roughness: 1, envMapIntensity: 0 } : { roughness: 0.74, envMapIntensity: 0.95 })
        if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
          for (const morph of FACE_MORPHS) {
            const index = mesh.morphTargetDictionary[morph]
            if (index === undefined) continue
            const slots = this.morphs.get(morph) ?? []
            slots.push({ influences: mesh.morphTargetInfluences, index })
            this.morphs.set(morph, slots)
          }
        }
      }
      const bone = o as THREE.Bone
      if (bone.isBone && /Head$/.test(bone.name) && !/HeadTop/.test(bone.name)) this.head = bone
      if (bone.isBone && /Hips$/.test(bone.name)) this.hips = bone
    })
    this.group.add(this.model)
    // In the bind pose the face looks along the character's +Z; keep that direction in head space so
    // lookAt can tell how far the animation tips the head up or down.
    if (this.head) {
      this.group.updateMatrixWorld(true)
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.getWorldQuaternion(new THREE.Quaternion()))
      this.faceAxis = forward.applyQuaternion(this.head.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize()
    }
    this.mixer = new THREE.AnimationMixer(this.model)
    for (const clip of clips) {
      const action = this.mixer.clipAction(clip)
      action.time = Math.random() * clip.duration // keep characters out of step
      this.actions.set(clip.name as Mood, action)
    }
    this.findArms()
    this.setMood('sit', 0)
  }

  setMood(mood: Mood, fade = 0.5) {
    if (mood === this.mood || !this.actions.has(mood)) return
    const next = this.actions.get(mood)!
    const previous = this.mood ? this.actions.get(this.mood) : null
    next.reset()
    next.time = Math.random() * next.getClip().duration
    next.setEffectiveWeight(1).play()
    if (previous && fade > 0) previous.crossFadeTo(next, fade, false)
    else previous?.stop()
    this.mood = mood
  }

  /**
   * The speaking face: while this member talks the mouth follows their voice, and it returns to rest when the
   * voice stops. `reading` is what this window hears right now, or null while an AI agent holds the floor.
   * Characters without the face rig are left alone.
   */
  updateFace(dt: number, time: number, reading: VoiceReading | null) {
    if (this.morphs.size === 0) return
    let voice: VoiceSample | null = null
    if (this.talking) {
      this.talkingFor += dt
      if (reading?.state === 'level') {
        this.voiceHeard = true
        voice = reading
      } else if (reading?.state === 'unmetered') {
        // A voice is playing but cannot be analysed here: the procedural mouth stands in while it plays.
        this.voiceHeard = true
      } else if (reading?.state === 'silent' && (this.voiceHeard || this.talkingFor < VOICE_GRACE)) {
        // Their clip has ended, or has not started yet: the mouth stays shut.
        voice = QUIET_VOICE
      }
      // Otherwise nobody's audio plays here (a live microphone in another window): procedural mouth.
    } else {
      this.talkingFor = 0
      this.voiceHeard = false
    }
    const blink = this.blinks ? this.blinker.update(dt, this.talking) : 0
    const weights = faceFrame(this.face, { talking: this.talking, voice }, blink, time, this.faceSeed, dt)
    for (const [morph, slots] of this.morphs) {
      for (const slot of slots) slot.influences[slot.index] = weights[morph]
    }
    this.speaking = approach(this.speaking, Math.min(1, (weights.MouthOpen / SPEECH_MOUTH_MAX) * 3), 2.5, dt)
  }

  /** Turn the head toward a world point after the animation pose is applied. */
  lookAt(target: THREE.Vector3 | null, dt: number, time: number) {
    if (!this.head || !this.head.parent) return
    // A small nod and turn while the mouth is moving, so a speaker is not a still head with a moving jaw.
    const speech = speechHead(time, this.faceSeed, this.speaking)
    let desired = 0
    let elevation: number | null = null
    if (target) {
      const local = this.group.worldToLocal(target.clone())
      const headLocal = this.group.worldToLocal(this.head.getWorldPosition(new THREE.Vector3()))
      desired = THREE.MathUtils.clamp(Math.atan2(local.x - headLocal.x, local.z - headLocal.z), -1.1, 1.1)
      elevation = Math.atan2(local.y - headLocal.y, Math.hypot(local.x - headLocal.x, local.z - headLocal.z))
    }
    this.yaw = THREE.MathUtils.damp(this.yaw, desired, 4, dt)
    const world = this.head.getWorldQuaternion(new THREE.Quaternion())
    world.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, this.yaw + speech.yaw))
    // Lift (or lower) the face toward the target: the seated clips tip the head down toward the
    // laptop, which hides a speaker's mouth from the presenter camera. Most of the gap is closed,
    // so the clip's small nods still show.
    let correction = 0
    if (this.faceAxis && elevation !== null) {
      const facing = this.faceAxis.clone().applyQuaternion(world)
      const current = Math.asin(THREE.MathUtils.clamp(facing.y, -1, 1))
      correction = THREE.MathUtils.clamp((elevation - current) * 0.8, -0.25, 0.5)
    }
    this.pitch = THREE.MathUtils.damp(this.pitch, correction, 4, dt)
    const lift = this.pitch + speech.pitch
    if (this.faceAxis && Math.abs(lift) > 1e-4) {
      const facing = this.faceAxis.clone().applyQuaternion(world)
      const axis = new THREE.Vector3().crossVectors(facing, UP)
      if (axis.lengthSq() > 1e-6) world.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.normalize(), lift))
    }
    const parent = this.head.parent.getWorldQuaternion(new THREE.Quaternion())
    this.head.quaternion.copy(parent.invert().multiply(world))
  }

  headPosition(out = new THREE.Vector3()) {
    return this.head ? this.head.getWorldPosition(out) : out.copy(this.group.position).setY(1.2)
  }

  /**
   * Two bone IK that keeps the hands in place in every mood, applied after the animation pose: each hand rests on
   * its own thigh under the table (or, when MOUSE_SIDE names one, that hand lies on the mouse beside the laptop). The
   * body still plays the full clip (shoulders, torso and head move as it talks); the hands themselves stay put.
   */
  placeHands() {
    for (const arm of this.arms) arm.hand.scale.setScalar(HAND_SCALE)
    const w = this.handWeight
    if (w < 0.01) return
    const toWorld = this.group.getWorldQuaternion(new THREE.Quaternion())
    const local = (bone: THREE.Object3D) => this.group.worldToLocal(bone.getWorldPosition(new THREE.Vector3()))
    const height = (y: number) => this.group.localToWorld(new THREE.Vector3(0, y, 0)).y
    for (const arm of this.arms) {
      const onMouse = arm.side === MOUSE_SIDE
      const animated = local(arm.hand)
      let target: THREE.Vector3
      let forward: THREE.Vector3
      if (onMouse) {
        target = new THREE.Vector3(MOUSE_WRIST.x, MOUSE_WRIST.y, MOUSE_WRIST.z)
        // Straight along the mouse, tipping down over it.
        forward = new THREE.Vector3(0.02, -0.16, 1)
      } else {
        // On top of the thigh, fingers toward the knee.
        const hip = local(arm.thigh)
        const knee = local(arm.knee)
        target = hip.clone().lerp(knee, LAP_ALONG)
        target.y += THIGH + WRIST_CLEARANCE
        forward = knee.sub(hip)
      }
      target.lerpVectors(animated, target, w)
      const pole = new THREE.Vector3(0.6 * arm.side, -0.5, -0.6).normalize().applyQuaternion(toWorld)
      solveTwoBone(arm, this.group.localToWorld(target), pole)
      orientHand(arm, forward.normalize().applyQuaternion(toWorld), w)
    }
    for (const finger of this.fingers) finger.bone.quaternion.slerp(finger.open, (finger.side === MOUSE_SIDE ? MOUSE_FINGER_RELAX : FINGER_RELAX) * w)
    // Contact: no finger joint may end inside what its hand lies on (the mouse and the tabletop round it, or the
    // thigh); bend it up to lie on the surface.
    const surfaces = new Map<number, (point: THREE.Vector3) => number>()
    for (const arm of this.arms) {
      if (arm.side === MOUSE_SIDE) {
        gatherFingers(arm, this.fingerChains.filter((chain) => chain.side === arm.side && !chain.thumb).map((chain) => chain.bones), MOUSE_FINGER_GATHER * w)
        surfaces.set(arm.side, (point) => {
          const at = this.group.worldToLocal(point.clone())
          return height(TABLE.height + mouseTop(at.x, at.z) + FINGER_CLEARANCE)
        })
      } else {
        const hip = local(arm.thigh)
        const knee = local(arm.knee)
        surfaces.set(arm.side, (point) => {
          const at = this.group.worldToLocal(point.clone())
          const along = THREE.MathUtils.clamp((at.z - hip.z) / (knee.z - hip.z || 1), 0, 1)
          return height(THREE.MathUtils.lerp(hip.y, knee.y, along) + THIGH + FINGER_CLEARANCE)
        })
      }
    }
    for (const chain of this.fingerChains) {
      const surface = surfaces.get(chain.side)
      if (surface) layOnSurface(chain.bones, surface, w)
    }
  }

  arms: Arm[] = []
  handWeight = 1
  private overridden: THREE.Bone[] = []
  private animatedPose: THREE.Quaternion[] = []

  /**
   * Advance the animation. three.js only writes a bone when its animated value changes, so a
   * constant clip like `sit` would leave last frame's IK and head turn in place and they would
   * compound. Restoring the animated pose of the overridden bones first prevents that.
   */
  animate(dt: number) {
    if (!this.mixer) return
    this.overridden.forEach((bone, i) => bone.quaternion.copy(this.animatedPose[i]))
    this.mixer.update(dt)
    this.overridden.forEach((bone, i) => this.animatedPose[i].copy(bone.quaternion))
    this.group.updateMatrixWorld(true)
  }

  findArms() {
    const bones = new Map<string, THREE.Bone>()
    this.model?.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.set(o.name.replace(/^mixamorig\d*/, ''), o as THREE.Bone)
    })
    this.arms = (['Left', 'Right'] as const).flatMap((side) => {
      const upper = bones.get(`${side}Arm`)
      const fore = bones.get(`${side}ForeArm`)
      const hand = bones.get(`${side}Hand`)
      const middle = bones.get(`${side}HandMiddle1`)
      const index = bones.get(`${side}HandIndex1`)
      const pinky = bones.get(`${side}HandPinky1`)
      const thigh = bones.get(`${side}UpLeg`)
      const knee = bones.get(`${side}Leg`)
      if (!upper || !fore || !hand || !middle || !index || !pinky || !thigh || !knee) return []
      return [{ side: side === 'Left' ? 1 : -1, upper, fore, hand, middle, index, pinky, thigh, knee } as Arm]
    })
    const sideOf = (name: string): 1 | -1 => name.startsWith('Left') ? 1 : -1
    this.fingerChains = ['Left', 'Right'].flatMap((side) => ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].map((finger) => ({
      side: sideOf(side),
      thumb: finger === 'Thumb',
      bones: [1, 2, 3, 4].map((joint) => bones.get(`${side}Hand${finger}${joint}`)).filter((bone): bone is THREE.Bone => Boolean(bone)),
    }))).filter((chain) => chain.bones.length >= 2)
    // Called before any clip plays, so current rotations are the open-handed bind pose.
    this.fingers = [...bones.entries()]
      .filter(([name]) => /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)[1-3]$/.test(name))
      .map(([name, bone]) => ({ bone, open: bone.quaternion.clone(), side: sideOf(name) }))
    this.overridden = [
      ...this.arms.flatMap((arm) => [arm.upper, arm.fore, arm.hand]),
      ...this.fingers.map((f) => f.bone),
      ...(this.head ? [this.head] : []),
    ]
    this.animatedPose = this.overridden.map((bone) => bone.quaternion.clone())
  }

  /** Finger joints with their open (bind) rotation; `side` is +1 for the character's left hand, -1 for the right. */
  private fingers: { bone: THREE.Bone; open: THREE.Quaternion; side: 1 | -1 }[] = []
  /** Each finger and thumb as its joints from knuckle to tip, for the contact step. */
  private fingerChains: { side: 1 | -1; thumb: boolean; bones: THREE.Bone[] }[] = []
}

interface Arm {
  /** +1 for the character's left (its +X), -1 for its right. */
  side: 1 | -1
  upper: THREE.Bone
  fore: THREE.Bone
  hand: THREE.Bone
  middle: THREE.Bone
  index: THREE.Bone
  pinky: THREE.Bone
  /** The same side's hip and knee joints: the thigh the resting hand lies on. */
  thigh: THREE.Bone
  knee: THREE.Bone
}

const position = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3())

/** Rotate a bone in world space, keeping the result as a local rotation. */
function rotateWorld(bone: THREE.Object3D, rotation: THREE.Quaternion) {
  const world = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(rotation)
  const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion())
  bone.quaternion.copy(parent.invert().multiply(world))
  bone.updateMatrixWorld(true)
}

function aim(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  rotateWorld(bone, new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize()))
}

function solveTwoBone(arm: Arm, target: THREE.Vector3, pole: THREE.Vector3) {
  const a = position(arm.upper)
  const b = position(arm.fore)
  const c = position(arm.hand)
  const l1 = a.distanceTo(b)
  const l2 = b.distanceTo(c)
  const toTarget = target.clone().sub(a)
  const d = THREE.MathUtils.clamp(toTarget.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999)
  const dir = toTarget.normalize()
  const cos = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1)
  const bend = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize()
  const elbow = a.clone().addScaledVector(dir, l1 * cos).addScaledVector(bend, l1 * Math.sqrt(1 - cos * cos))
  aim(arm.upper, b.clone().sub(a), elbow.clone().sub(a))
  const b2 = position(arm.fore)
  aim(arm.fore, position(arm.hand).sub(b2), a.clone().addScaledVector(dir, d).sub(b2))
}

/**
 * Bend each joint of a finger up just enough that the next joint stays at or above the surface
 * height, so fingers rest on the tabletop (or on what lies on it) instead of sinking in. `surface`
 * is a height, or the height under a world point.
 */
function layOnSurface(chain: THREE.Bone[], surface: number | ((point: THREE.Vector3) => number), weight: number) {
  for (let i = 0; i < chain.length - 1; i++) {
    const from = position(chain[i])
    const to = position(chain[i + 1])
    const floor = typeof surface === 'number' ? surface : surface(to)
    if (to.y >= floor) continue
    const dir = to.clone().sub(from)
    const length = dir.length()
    const rise = THREE.MathUtils.clamp(floor - from.y, -length, length)
    const flat = new THREE.Vector3(dir.x, 0, dir.z)
    if (flat.lengthSq() < 1e-8) continue
    flat.setLength(Math.sqrt(Math.max(0, length * length - rise * rise)))
    const wanted = flat.setY(rise)
    rotateWorld(chain[i], new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(dir.normalize(), wanted.normalize()), weight))
  }
}

/**
 * Bring the fingers of an open hand together: turn each finger at its knuckle, in the plane of the palm,
 * toward the direction the hand points, taking out `amount` of its spread.
 */
function gatherFingers(arm: Arm, chains: THREE.Bone[][], amount: number) {
  const dir = position(arm.middle).sub(position(arm.hand)).normalize()
  const normal = position(arm.index).sub(position(arm.pinky)).cross(dir).normalize()
  const inPalm = (v: THREE.Vector3) => v.addScaledVector(normal, -v.dot(normal)).normalize()
  const ahead = inPalm(dir.clone())
  for (const chain of chains) {
    if (chain.length < 2) continue
    const finger = inPalm(position(chain[1]).sub(position(chain[0])))
    const spread = Math.atan2(normal.dot(finger.clone().cross(ahead)), finger.dot(ahead))
    rotateWorld(chain[0], new THREE.Quaternion().setFromAxisAngle(normal, spread * amount))
  }
}

/** Point the fingers forward and turn the palm down, blended by weight. */
function orientHand(arm: Arm, forward: THREE.Vector3, weight: number) {
  const hand = position(arm.hand)
  const current = position(arm.middle).sub(hand).normalize()
  rotateWorld(arm.hand, new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(current, forward), weight))
  const dir = position(arm.middle).sub(position(arm.hand)).normalize()
  const across = position(arm.index).sub(position(arm.pinky))
  const palm = across.cross(dir).multiplyScalar(-arm.side)
  const down = new THREE.Vector3(0, -1, 0)
  const flat = (v: THREE.Vector3) => v.addScaledVector(dir, -v.dot(dir)).normalize()
  const p = flat(palm)
  const q = flat(down)
  const angle = Math.atan2(dir.dot(p.clone().cross(q)), p.dot(q))
  rotateWorld(arm.hand, new THREE.Quaternion().setFromAxisAngle(dir, angle * weight))
}

export class Boardroom {
  private renderer: THREE.WebGPURenderer
  private post: THREE.PostProcessing
  /** Output graphs with and without ambient occlusion, so quality can step down without rebuilding. */
  private outputs: { full: THREE.Node; light: THREE.Node } | null = null
  /** 'WebGPU' or 'WebGL2' once the renderer has initialised (WebGPURenderer falls back automatically). */
  backend = ''
  private disposed = false
  /** Rendering runs only while the 3D stage is shown; the call view pauses it. */
  private active = true
  private started = false
  private tags: SeatTags
  private size = { width: 1, height: 1 }
  get aoEnabled() {
    return this.outputs !== null && this.post.outputNode === this.outputs.full
  }
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(36, 1, 0.05, 60)
  private controls: OrbitControls
  private clock = new THREE.Clock()
  private avatars: Avatar[]
  private chairs: THREE.Object3D[] = []
  /** Placeholder walls, floor and windows; hidden once the baked room from tools/build_room.py loads. */
  private shell = new THREE.Group()
  /** The baked room once loaded (null while the placeholder room shows). */
  room: THREE.Object3D | null = null
  private laptops: THREE.Object3D[] = []
  private consoles: THREE.Object3D[] = []
  private mice: THREE.Object3D[] = []
  private bezel!: THREE.Mesh
  private screen!: THREE.Mesh
  private screenCanvas = document.createElement('canvas')
  private screenTexture: THREE.CanvasTexture
  private screenKey = ''
  private view: BoardroomView | null = null
  /** Local time (ms) when the phase ends, from the deadline and the server clock it was read with. */
  private deadlineAt: number | null = null
  private clockKey = ''
  private container: HTMLElement
  // The hub: where the AI agents speak. A ring, a soft light column, a floating voice orb and a point light.
  private hub = new THREE.Group()
  private hubRing!: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
  private hubBeam!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>
  private hubOrb!: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  private hubHalo!: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  private hubLight!: THREE.PointLight
  private hubColor = new THREE.Color(AGENT_COLOR)
  private hubTarget = new THREE.Color(AGENT_COLOR)
  /** 0 to 1: how strongly an agent is talking (eased), and whether an AI is part of the phase. */
  private hubLevel = 0
  private hubPresence = 0
  private focus = new THREE.Vector3(-0.4, 0.95, 0)
  private userControlUntil = 0
  private frame = 0
  private resizeObserver: ResizeObserver
  /** The models are meshopt compressed (tools/optimize-models.mjs), so the loader needs the decoder. */
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  private seatOffset = new THREE.Vector3(0, 0.47, -0.08)
  onProgress: (loaded: number, total: number) => void = () => {}

  constructor(container: HTMLElement) {
    mark('construct')
    this.container = container
    // WebGPU where the browser supports it, with three.js falling back to WebGL2 by itself.
    this.renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Neutral tone mapping keeps skin and fabric colours closer to their textures than ACES.
    this.renderer.toneMapping = THREE.NeutralToneMapping
    // Slightly over 1: the walnut room read murky at 1.0 (Nov 8 2026 playtest feedback: hard to look at).
    this.renderer.toneMappingExposure = 1.12
    container.appendChild(this.renderer.domElement)
    const vignette = document.createElement('div')
    vignette.className = 'board3d-vignette'
    container.appendChild(vignette)

    this.post = new THREE.PostProcessing(this.renderer)

    // One tag per seat plus one for the agent at the hub.
    this.tags = new SeatTags(CHARACTER_IDS.length + 1)
    container.appendChild(this.tags.element)

    this.camera.position.set(6.4, 3.0, 0.0)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.copy(this.focus)
    this.controls.enableDamping = true
    this.controls.minDistance = 1.2
    this.controls.maxDistance = 15
    this.controls.minPolarAngle = 0.05
    this.controls.maxPolarAngle = Math.PI * 0.495
    this.controls.enablePan = true
    this.controls.screenSpacePanning = true
    this.controls.panSpeed = 0.8
    this.controls.zoomToCursor = true
    // While the player steers, the camera stops following the speaker; it resumes after a pause.
    this.controls.addEventListener('start', () => (this.userControlUntil = Infinity))
    this.controls.addEventListener('end', () => (this.userControlUntil = performance.now() + 10000))
    this.renderer.domElement.addEventListener('dblclick', () => this.resetView())

    this.screenCanvas.width = 1024
    this.screenCanvas.height = 676
    this.screenTexture = new THREE.CanvasTexture(this.screenCanvas)
    this.screenTexture.colorSpace = THREE.SRGBColorSpace
    // WebGPU cannot upload a canvas that has no 2D context yet, so draw the first frame now.
    this.drawScreen()

    this.buildRoom()
    this.avatars = makeSeats().map((seat) => {
      const avatar = new Avatar(seat)
      this.scene.add(avatar.group)
      return avatar
    })
    this.buildFurniture()
    this.buildHub()

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    void this.start()
    this.loadModels()
    void this.loadProps()
    void this.loadRoom()
  }

  /** WebGPU initialises asynchronously; the environment and post processing need a ready backend. */
  private async start() {
    await this.renderer.init()
    if (this.disposed) return
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean }
    this.backend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'
    mark('renderer')
    console.info('[boardroom] renderer backend:', this.backend)

    // Image based lighting: soft reflections and bounce light for every PBR material.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    // Soft even light on faces and suits, so characters are not lit only by the warm lamps.
    this.scene.environmentIntensity = 0.8
    pmrem.dispose()

    this.buildPost()
    mark('environment')
    this.started = true
    if (this.active) this.renderer.setAnimationLoop(() => this.render())
  }

  /** Pause or resume rendering (the call view hides the 3D stage without unloading it). */
  setActive(active: boolean) {
    if (active === this.active) return
    this.active = active
    if (!this.started || this.disposed) return
    if (active) {
      this.clock.getDelta() // drop the paused time so animations do not jump
      this.resize()
      this.renderer.setAnimationLoop(() => this.render())
    } else {
      this.renderer.setAnimationLoop(null)
    }
  }

  /**
   * Node based post processing: a 4x multisampled scene pass that also writes view normals,
   * half resolution GTAO for contact shading, and bloom so light lines, screens and other
   * values above 1 glow. Tone mapping and colour conversion happen once at the end.
   */
  private buildPost() {
    const scenePass = pass(this.scene, this.camera, { samples: 4 })
    scenePass.setMRT(mrt({ output, normal: normalView }))
    const color = scenePass.getTextureNode('output')
    const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), this.camera)
    aoPass.resolutionScale = 0.5
    aoPass.radius.value = 0.32
    aoPass.thickness.value = 1.2
    aoPass.distanceExponent.value = 1.4
    aoPass.scale.value = 1.15
    aoPass.samples.value = 12
    const occluded = color.mul(vec4(vec3(aoPass.getTextureNode().r), 1))
    this.outputs = {
      full: occluded.add(bloom(occluded, 0.28, 0.45, 0.92)),
      light: color.add(bloom(color, 0.28, 0.45, 0.92)),
    }
    this.post.outputNode = this.outputs.full
    this.post.needsUpdate = true
  }

  dispose() {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.post.dispose()
    this.renderer.dispose()
    this.container.replaceChildren()
  }

  update(view: BoardroomView, clock: SceneClock) {
    this.view = view
    const key = `${clock.deadline}|${clock.serverTime}`
    if (key !== this.clockKey) {
      this.clockKey = key
      this.deadlineAt = clock.deadline && clock.serverTime ? Date.now() + Date.parse(clock.deadline) - Date.parse(clock.serverTime) : null
    }
    this.avatars.forEach((avatar, index) => {
      const seat = view.seats[index]
      avatar.group.visible = Boolean(seat)
      this.chairs[index]?.position.copy(this.chairPosition(avatar))
      if (this.laptops[index]) this.laptops[index].visible = Boolean(seat)
      if (this.consoles[index]) this.consoles[index].visible = Boolean(seat)
      if (this.mice[index]) this.mice[index].visible = Boolean(seat)
      // Your own character faces away from the overview camera, so it needs no tag.
      this.tags.set(index, seat && !seat.isSelf ? {
        name: seat.name,
        initial: seat.name.charAt(0).toUpperCase(),
        role: seat.role,
        color: seat.color,
        speaking: seat.talking,
        away: !seat.connected,
      } : null)
      avatar.talking = Boolean(seat?.talking)
      if (seat) { this.loadCharacter(index); avatar.setMood(seat.mood) }
    })
    const agent = view.agent
    this.tags.set(CHARACTER_IDS.length, agent ? {
      name: agent.name,
      initial: 'AI',
      role: agent.role,
      color: agent.accent ?? AGENT_COLOR,
      speaking: true,
      away: false,
      agent: true,
    } : null)
    this.hubTarget.set(agent?.accent ?? AGENT_COLOR)
  }

  // ---- loading ----

  /** A model from the shared downloads (models embed their textures, so no resource path is needed). */
  private async gltf(url: string, priority: 'auto' | 'low' = 'auto'): Promise<GLTF> {
    const bytes = await fetchAsset(url, priority)
    const begun = performance.now()
    const gltf = await this.loader.parseAsync(bytes, '')
    performance.measure(`board3d:parse:${url.split('/').pop()}`, { start: begun, end: performance.now() })
    return gltf
  }

  /** The shared animation clips; every character waits for them before it can sit. */
  private library: Promise<GLTF> | null = null
  /** Characters requested so far (by seat index) and how many have attached, for the loading counter. */
  private characters = new Map<number, Promise<void>>()
  private attached = 0
  private libraryReady = false

  private reportProgress() {
    this.onProgress(this.attached + (this.libraryReady ? 1 : 0), Math.max(1, this.characters.size) + 1)
  }

  private loadModels() {
    this.library = this.gltf(`${MODELS}characters/animations.glb`)
    this.library.then(() => { this.libraryReady = true; this.reportProgress() }, () => undefined)
    // Before the first snapshot arrives, start the first seat so the head of the table is never empty.
    this.loadCharacter(0)
  }

  /**
   * A seat's character, downloaded and attached the first time someone sits there (most bytes are already in memory
   * from the lobby preload). Empty seats never download their model.
   */
  private loadCharacter(index: number) {
    if (this.characters.has(index) || !this.library || index >= CHARACTER_IDS.length) return
    const library = this.library
    const job = (async () => {
      const [gltf, { animations: clips }] = await Promise.all([this.gltf(`${MODELS}characters/${CHARACTER_IDS[index]}.glb`), library])
      if (this.disposed) return
      const avatar = this.avatars[index]
      avatar.attach(gltf, clips, CHARACTER_IDS[index])
      if (this.view?.seats[index]) avatar.setMood(this.view.seats[index].mood)
      if (this.attached === 0) {
        this.calibrateSeat(avatar)
        this.avatars.forEach((other, seat) => this.chairs[seat]?.position.copy(this.chairPosition(other)))
      }
      this.attached += 1
      mark(`character:${index}`)
      this.reportProgress()
      this.loadedAtFrame = this.frame
    })()
    job.catch((error) => { this.characters.delete(index); console.warn('[boardroom] character failed to load', CHARACTER_IDS[index], error) })
    this.characters.set(index, job)
    this.reportProgress()
  }

  /** Measure where the seated pose puts the hips so chairs sit under every character. */
  private calibrateSeat(avatar: Avatar) {
    if (!avatar.mixer || !avatar.hips) return
    // Through `animate`, not the mixer directly: it records the seated pose the hand placement starts from each
    // frame. Updating the mixer alone left this one character starting from its bind pose, with a different arm twist.
    avatar.animate(0)
    const hips = avatar.group.worldToLocal(avatar.hips.getWorldPosition(new THREE.Vector3()))
    this.seatOffset.set(hips.x, Math.max(0.38, hips.y - 0.1), hips.z - 0.06)
  }

  private chairPosition(avatar: Avatar) {
    const offset = this.seatOffset.clone().setY(0).applyAxisAngle(UP, avatar.seat.yaw)
    return avatar.seat.position.clone().add(offset)
  }

  private async loadProps() {
    try {
      // props.json: { conventions: { front: "+Z", origin: base at Y=0 }, models: [{ id, file, ... }] }
      const manifest = await propManifest()
      if (!manifest) return
      // Only large furniture casts shadows; small props add shadow pass cost for no visible gain.
      const load = async (word: PropWord, castShadow = false) => {
        const url = propUrl(manifest.models, word)
        if (!url) return null
        const gltf = await this.gltf(url, 'low')
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = castShadow
            o.receiveShadow = true
            tuneMaterial((o as THREE.Mesh).material as THREE.MeshStandardMaterial, {})
          }
        })
        return gltf.scene
      }
      // Prop origins sit at the centre of their base. The back wall face is at z = -3.6.
      const WALL = -3.6
      // Start every download before placing anything (an `await` inside the list below would load them one by one).
      const loading = {
        table: load('table', true), chair: load('chair', true), credenza: load('credenza', true),
        water: load('water-service'), plant: load('plant'), clock: load('clock'), hub: load('holo-hub'),
        display: load('display'), laptop: load('laptop'), console: load('console'),
      }
      for (const promise of Object.values(loading)) promise.catch(() => undefined)
      await Promise.all([
        this.swapProp(await loading.table, 'table', (model) => {
          model.position.set(0, 0, 0)
          // The Tripo table texture reads grey and weathered; tint it toward the dark walnut concept.
          model.traverse((o) => {
            const material = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
            if (material?.isMeshStandardMaterial) material.color.set('#9a7457')
          })
        }, true),
        loading.chair.then((model) => this.swapChairs(model)),
        loading.credenza.then((model) => this.placeProp(model, new THREE.Vector3(0, 0, WALL + 0.25), 0)),
        loading.water.then((model) => this.placeProp(model, new THREE.Vector3(0.62, 0.756, WALL + 0.25), 0)),
        // One plant download, two plants.
        loading.plant.then((model) => Promise.all([
          this.placeProp(model?.clone() ?? null, new THREE.Vector3(-4.6, 0, 2.9), 0),
          this.placeProp(model, new THREE.Vector3(-4.6, 0, -2.9), 0),
        ])),
        // The clock is 0.5 m across; centre it at y = 1.95.
        loading.clock.then((model) => this.placeProp(model, new THREE.Vector3(2.0, 1.7, WALL + 0.063), 0)),
        loading.hub.then((model) => this.placeProp(model, new THREE.Vector3(0, TABLE.height, 0), 0)),
        loading.display.then((model) => this.mountDisplay(model)),
        loading.laptop.then((model) => this.swapLaptops(model)),
        loading.console.then((model) => this.placeConsoles(model)),
      ])
      mark('props')
    } catch (error) {
      console.warn('[boardroom] props not loaded', error)
    }
  }

  private fallbacks = new Map<string, THREE.Object3D>()

  private async swapProp(model: THREE.Object3D | null, key: string, place: (m: THREE.Object3D) => void, rotate = false) {
    if (!model) return
    if (rotate) model.rotation.y = 0
    place(model)
    this.fallbacks.get(key)?.removeFromParent()
    this.scene.add(model)
  }

  /**
   * The baked room (public/models/room, built by tools/build_room.py). Its surfaces carry fully
   * baked lighting and render unlit; `Glass` becomes a faint reflective pane in front of the
   * skyline panorama, and `Emit_*` meshes are pushed above 1 so the bloom pass makes them glow.
   */
  private async loadRoom() {
    // The room model downloads while its settings file is read, and the skyline while the room is parsed.
    const room = this.gltf(`${MODELS}room/room.glb`)
    room.catch(() => undefined)
    try {
      const info = await roomManifest()
      if (!info) { this.placeholderFog(); return }
      const skyInfo = roomSky(info)
      const skyLoading = skyInfo ? this.skyTexture(skyInfo.url) : null
      skyLoading?.catch(() => undefined)
      const gltf = await room
      const boost = info.emissive_boost ?? 3
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = false
        mesh.receiveShadow = false
        const material = mesh.material as THREE.MeshBasicMaterial
        // Single sided surfaces face inward, so walls and ceiling between an outside camera and the
        // table are culled: zooming out gives a cutaway view instead of the back of a wall.
        material.side = THREE.FrontSide
        if (material.map) material.map.anisotropy = 8
        // The room is unlit with baked textures; lift it a little so the dark walnut walls do not swallow the scene.
        if (!mesh.name.startsWith('Glass') && !mesh.name.startsWith('Emit_') && material.color) material.color.multiplyScalar(1.3)
        if (mesh.name.startsWith('Glass')) {
          mesh.material = new THREE.MeshPhysicalMaterial({
            color: '#c9d6dc', transparent: true, opacity: 0.1, roughness: 0.04, metalness: 0,
            envMapIntensity: 1.2, depthWrite: false,
          })
          mesh.renderOrder = 2
        } else if (mesh.name.startsWith('Emit_')) {
          const glow = (material as unknown as THREE.MeshStandardMaterial).emissive ?? material.color
          mesh.material = new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(boost) })
        }
      })
      if (skyInfo && skyLoading) {
        this.scene.background = await skyLoading
        // three.js samples u = 0.5 + atan2(z, x) / 2pi, so -X looks at u = 0; rotate the chosen u there.
        this.scene.backgroundRotation.y = skyInfo.three_background_rotation_y_rad_suggested ?? Math.PI + Math.PI * 2 * ((skyInfo.u_facing_minus_x ?? 0.5) - 0.5)
      } else this.placeholderFog()
      this.shell.visible = false
      this.scene.add(gltf.scene)
      this.room = gltf.scene
      mark('room')
    } catch (error) {
      console.warn('[boardroom] baked room unavailable, keeping the placeholder room', error)
      this.placeholderFog()
    }
  }

  /**
   * The skyline panorama from the shared downloads. Where the browser can flip a bitmap while decoding, it is
   * decoded off the main thread; an image element was decoded on the main thread by the first frame that drew it.
   */
  private async skyTexture(url: string) {
    const bytes = await fetchAsset(url)
    const type = url.endsWith('.webp') ? 'image/webp' : url.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const blob = new Blob([bytes], { type })
    let sky: THREE.Texture
    if (bitmapsFlip()) {
      // Flipped while decoding and not at upload: the WebGL2 fallback cannot flip an ImageBitmap.
      sky = new THREE.Texture(await createImageBitmap(blob, { imageOrientation: 'flipY' }))
      sky.flipY = false
      sky.needsUpdate = true
    } else {
      const source = URL.createObjectURL(blob)
      try { sky = await new THREE.TextureLoader().loadAsync(source) } finally { URL.revokeObjectURL(source) }
    }
    sky.mapping = THREE.EquirectangularReflectionMapping
    sky.colorSpace = THREE.SRGBColorSpace
    return sky
  }

  /** Distance haze for the plain backdrop, added only when there is no skyline panorama to look at. */
  private placeholderFog() {
    this.scene.fog = new THREE.Fog('#e9e5da', 14, 30)
  }

  private async placeProp(model: THREE.Object3D | null, position: THREE.Vector3, yaw: number) {
    if (!model) return
    model.position.copy(position)
    model.rotation.y = yaw
    this.scene.add(model)
  }

  /**
   * The brass framed display hangs centred at (-0.4, 1.75) on the back wall. The live canvas
   * screen (phase, decision and timer) moves onto its glass, and the placeholder bezel goes.
   */
  private async mountDisplay(model: THREE.Object3D | null) {
    if (!model) return
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
    model.position.set(-0.4, 1.75 - size.y / 2, -3.6 + size.z / 2)
    this.scene.add(model)
    this.bezel.visible = false
    this.screen.geometry.dispose()
    this.screen.geometry = new THREE.PlaneGeometry(size.x * 0.935, size.y * 0.885)
    this.screen.position.set(-0.4, 1.75 + size.y * 0.005, -3.6 + size.z + 0.004)
  }

  /** A voting console at every seat, to the player's right of the laptop, screen toward them. */
  private async placeConsoles(model: THREE.Object3D | null) {
    if (!model) return
    this.avatars.forEach((avatar, index) => {
      const unit = model.clone()
      const toward = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, avatar.seat.yaw)
      const right = new THREE.Vector3(-1, 0, 0).applyAxisAngle(UP, avatar.seat.yaw)
      unit.position.copy(avatar.seat.position).addScaledVector(toward, EDGE_GAP + 0.13).addScaledVector(right, 0.4).setY(TABLE.height)
      unit.rotation.y = avatar.seat.yaw + Math.PI
      unit.visible = this.laptops[index]?.visible ?? true
      this.scene.add(unit)
      this.consoles[index] = unit
    })
  }

  private async swapChairs(model: THREE.Object3D | null) {
    if (!model) return
    this.chairs.forEach((chair, index) => {
      const replacement = model.clone()
      // Props face +Z, like the characters, so a chair takes its seat's yaw.
      replacement.rotation.y = this.avatars[index].seat.yaw
      replacement.position.copy(chair.position)
      chair.removeFromParent()
      this.scene.add(replacement)
      this.chairs[index] = replacement
    })
  }

  private async swapLaptops(model: THREE.Object3D | null) {
    if (!model) return
    this.laptops.forEach((laptop, index) => {
      const replacement = model.clone()
      replacement.position.copy(laptop.position)
      replacement.rotation.copy(laptop.rotation)
      replacement.visible = laptop.visible
      laptop.removeFromParent()
      this.scene.add(replacement)
      this.laptops[index] = replacement
    })
  }

  // ---- static scene ----

  private buildRoom() {
    this.scene.background = new THREE.Color('#e9e5da')
    // No fog here: fog is part of every lit material's shader, so removing it when the baked room arrives
    // made three.js rebuild the shaders of every character and prop a second time (see `placeholderFog`).

    const hemi = new THREE.HemisphereLight('#fffaf0', '#7a6a58', 0.85)
    this.scene.add(hemi)
    // Cool window light from the far wall gives characters a rim and separates them from the room.
    const windowLight = new THREE.DirectionalLight('#dbe8f2', 1.1)
    windowLight.position.set(-6, 3.2, 0.6)
    this.scene.add(windowLight)
    const sun = new THREE.DirectionalLight('#fff1dc', 2.4)
    sun.position.set(3.5, 6, 2.5)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.radius = 3
    sun.shadow.camera.left = -6
    sun.shadow.camera.right = 6
    sun.shadow.camera.top = 5
    sun.shadow.camera.bottom = -5
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.02
    this.scene.add(sun)
    // Neutral and gentler than before: a strong orange point light over the table turned hands orange.
    const fill = new THREE.PointLight('#fff0e2', 2.2, 9, 1.6)
    fill.position.set(0, 2.6, 0)
    this.scene.add(fill)

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 7.2), new THREE.MeshStandardMaterial({ color: '#8c7a66', roughness: 0.85 }))
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(this.shell)
    this.shell.add(floor)
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 3.6), new THREE.MeshStandardMaterial({ color: '#33473d', roughness: 1 }))
    rug.rotation.x = -Math.PI / 2
    rug.position.y = 0.004
    rug.receiveShadow = true
    this.shell.add(rug)

    const wall = new THREE.MeshStandardMaterial({ color: '#f1eee5', roughness: 0.95 })
    const back = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 3.2), wall)
    back.position.set(0, 1.6, -3.6)
    back.receiveShadow = true
    this.shell.add(back)
    const left = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 3.2), wall)
    left.position.set(-5.25, 1.6, 0)
    left.rotation.y = Math.PI / 2
    this.shell.add(left)
    const front = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 3.2), wall)
    front.position.set(0, 1.6, 3.6)
    front.rotation.y = Math.PI
    this.shell.add(front)

    // Window band on the far wall.
    const glass = new THREE.MeshBasicMaterial({ color: '#e4eef1', toneMapped: false })
    for (const z of [-2.2, 0, 2.2]) {
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.7), glass)
      pane.position.set(-5.24, 1.75, z)
      pane.rotation.y = Math.PI / 2
      this.shell.add(pane)
    }
    const trim = new THREE.MeshStandardMaterial({ color: '#213c32', roughness: 0.6 })
    const skirting = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.1, 0.03), trim)
    skirting.position.set(0, 0.05, -3.58)
    this.shell.add(skirting)

    // Wall display with the live phase and timer.
    const bezel = (this.bezel = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.22, 0.06), new THREE.MeshStandardMaterial({ color: '#141614', roughness: 0.4 })))
    bezel.position.set(-0.4, 1.75, -3.56)
    this.scene.add(bezel)
    const screen = (this.screen = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.125), new THREE.MeshBasicMaterial({ map: this.screenTexture, toneMapped: false })))
    screen.position.set(-0.4, 1.75, -3.525)
    this.scene.add(screen)
  }

  private buildFurniture() {
    const walnut = new THREE.MeshStandardMaterial({ color: '#5a3a26', roughness: 0.5 })
    const table = new THREE.Group()
    const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.length, 0.06, TABLE.width), walnut)
    top.position.y = TABLE.height - 0.03
    const base = new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.4, metalness: 0.5 })
    for (const x of [-1.3, 1.3]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, TABLE.height - 0.06, 0.9), base)
      leg.position.set(x, (TABLE.height - 0.06) / 2, 0)
      table.add(leg)
    }
    table.add(top)
    table.traverse((o) => {
      o.castShadow = true
      o.receiveShadow = true
    })
    this.fallbacks.set('table', table)
    this.scene.add(table)

    const leather = new THREE.MeshStandardMaterial({ color: '#1d1d1f', roughness: 0.55 })
    const steel = new THREE.MeshStandardMaterial({ color: '#8a8d90', roughness: 0.3, metalness: 0.8 })
    const laptopBody = new THREE.MeshStandardMaterial({ color: '#b9bcc0', roughness: 0.35, metalness: 0.6 })
    // The mouse under each right hand: the upper half of an ellipsoid, pale so it reads against the walnut top
    // and beneath the hand.
    const mouseShape = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)
    const mouseBody = new THREE.MeshStandardMaterial({ color: '#d7dade', roughness: 0.4, metalness: 0.15 })
    for (const avatar of this.avatars) {
      const chair = new THREE.Group()
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.09, 0.5), leather)
      seat.position.y = 0.44
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.08), leather)
      back.position.set(0, 0.8, -0.24)
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.38), steel)
      post.position.y = 0.2
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 20), steel)
      foot.position.y = 0.02
      chair.add(seat, back, post, foot)
      chair.rotation.y = avatar.seat.yaw
      chair.traverse((o) => {
        o.castShadow = true
        o.receiveShadow = true
      })
      this.chairs.push(chair)
      this.scene.add(chair)

      const laptop = new THREE.Group()
      const base2 = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.015, 0.23), laptopBody)
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.22, 0.01), laptopBody)
      lid.position.set(0, 0.1, -0.12)
      lid.rotation.x = -0.25
      laptop.add(base2, lid)
      const toward = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, avatar.seat.yaw)
      // Keyboard edge just past the table edge, where the typing clip's hands land.
      laptop.position.copy(avatar.seat.position).addScaledVector(toward, EDGE_GAP + 0.18).setY(TABLE.height + 0.008)
      laptop.rotation.y = avatar.seat.yaw + Math.PI
      laptop.traverse((o) => (o.castShadow = true))
      this.laptops.push(laptop)
      this.scene.add(laptop)

      // No mouse on the table while no hand rests on one.
      if (MOUSE_SIDE === 0) continue
      const mouse = new THREE.Mesh(mouseShape, mouseBody)
      mouse.scale.set(MOUSE.halfWidth, MOUSE.height, MOUSE.halfLength)
      // Seat space +X is the character's left, so the mouse (negative x) lies to their right.
      mouse.position.copy(avatar.seat.position).add(new THREE.Vector3(MOUSE.x, 0, MOUSE.z).applyAxisAngle(UP, avatar.seat.yaw)).setY(TABLE.height + 0.002)
      mouse.rotation.y = avatar.seat.yaw
      mouse.castShadow = true
      mouse.receiveShadow = true
      this.mice.push(mouse)
      this.scene.add(mouse)
    }
  }

  /**
   * The hub is the AI agents' seat at the table. A brass ring on the lens glows softly while an
   * AI is part of the phase; when an agent talks, the ring brightens, a translucent light column
   * rises, a voice orb floats and pulses above the lens, and a warm light falls on the table.
   * Values above 1 bloom in the post pass.
   */
  private buildHub() {
    this.hub.position.copy(HUB_TOP)
    this.scene.add(this.hub)
    this.hubRing = new THREE.Mesh(new THREE.TorusGeometry(0.205, 0.009, 12, 96), new THREE.MeshBasicMaterial({ color: AGENT_COLOR }))
    this.hubRing.rotation.x = -Math.PI / 2
    this.hubRing.position.y = 0.004
    this.hubHalo = new THREE.Mesh(
      new THREE.RingGeometry(0.21, 0.42, 64),
      new THREE.MeshBasicMaterial({ color: AGENT_COLOR, map: radialFade(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    )
    this.hubHalo.rotation.x = -Math.PI / 2
    this.hubHalo.position.y = -0.125
    this.hubBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.2, 0.62, 48, 1, true),
      new THREE.MeshBasicMaterial({
        color: AGENT_COLOR, map: verticalFade(), transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      }),
    )
    this.hubBeam.position.y = 0.31
    this.hubOrb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 32, 16), new THREE.MeshBasicMaterial({ color: AGENT_COLOR }))
    this.hubOrb.position.y = 0.34
    this.hubLight = new THREE.PointLight(AGENT_COLOR, 0, 3.2, 1.6)
    this.hubLight.position.y = 0.3
    this.hub.add(this.hubRing, this.hubHalo, this.hubBeam, this.hubOrb, this.hubLight)
  }

  private animateHub(dt: number, time: number) {
    const view = this.view
    this.hubLevel = THREE.MathUtils.damp(this.hubLevel, view?.agent ? 1 : 0, 5, dt)
    this.hubPresence = THREE.MathUtils.damp(this.hubPresence, view?.agentPresent ? 1 : 0, 3, dt)
    this.hubColor.lerp(this.hubTarget, 1 - Math.exp(-dt * 4))
    const level = this.hubLevel
    // A speech like flicker: two out of step waves, only while talking.
    const voice = Math.abs(Math.sin(time * 8.3) * Math.sin(time * 3.1 + 1.2))
    const breathe = 0.5 + 0.5 * Math.sin(time * 1.6)
    this.hubRing.material.color.copy(this.hubColor).multiplyScalar(0.35 + 0.9 * this.hubPresence * (0.8 + 0.2 * breathe) + level * (2.2 + 1.4 * voice))
    this.hubHalo.material.color.copy(this.hubColor)
    this.hubHalo.material.opacity = 0.12 * this.hubPresence + 0.5 * level
    this.hubBeam.visible = level > 0.01
    this.hubBeam.material.color.copy(this.hubColor)
    this.hubBeam.material.opacity = level * (0.3 + 0.12 * voice)
    this.hubBeam.rotation.y += dt * 0.4
    const orbShown = Math.max(level, this.hubPresence * 0.45)
    this.hubOrb.visible = orbShown > 0.02
    this.hubOrb.scale.setScalar(orbShown * (0.85 + 0.4 * voice * level))
    this.hubOrb.position.y = 0.32 + 0.025 * Math.sin(time * 1.3)
    this.hubOrb.material.color.copy(this.hubColor).multiplyScalar(1.2 + 3 * level)
    this.hubLight.color.copy(this.hubColor)
    this.hubLight.intensity = 0.5 * this.hubPresence + level * (3.2 + 1.2 * voice)
  }

  private hubAnchor(out = new THREE.Vector3()) {
    return out.copy(HUB_TOP).add(this.hubOrb.position)
  }

  // ---- frame ----

  private insets = { left: 0, right: 0, top: 0, bottom: 0 }

  /** Pixels covered by HUD panels; the view centre moves into the remaining clear area. */
  setInsets(insets: { left: number; right: number; top: number; bottom: number }) {
    this.insets = insets
    this.resize()
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.size = { width: w, height: h }
    this.camera.aspect = w / h
    const dx = (this.insets.left - this.insets.right) / 2
    const dy = (this.insets.top - this.insets.bottom) / 2
    if (dx || dy) this.camera.setViewOffset(w, h, -dx, -dy, w, h)
    else this.camera.clearViewOffset()
    this.camera.updateProjectionMatrix()
  }

  private drawScreen() {
    const screen = this.view?.screen
    const seconds = this.deadlineAt !== null ? Math.max(0, Math.ceil((this.deadlineAt - Date.now()) / 1000)) : null
    const clock = seconds === null ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    const key = `${screen?.title}|${screen?.subtitle}|${clock}`
    if (key === this.screenKey) return
    this.screenKey = key
    const ctx = this.screenCanvas.getContext('2d')!
    const { width: w, height: h } = this.screenCanvas
    const gradient = ctx.createLinearGradient(0, 0, w, h)
    gradient.addColorStop(0, '#16281f')
    gradient.addColorStop(1, '#213c32')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#ae5238'
    ctx.fillRect(64, 70, 90, 8)
    ctx.fillStyle = '#e9e5da'
    ctx.font = '600 30px "Segoe UI", Arial, sans-serif'
    ctx.fillText((screen?.subtitle ?? 'Connecting').toUpperCase(), 64, 130)
    ctx.font = '600 58px "Segoe UI", Arial, sans-serif'
    wrap(ctx, screen?.title ?? 'Boardroom Crisis Simulator', 64, 210, w - 128, 68, 3)
    if (clock) {
      ctx.font = '300 120px "Segoe UI", Arial, sans-serif'
      ctx.fillStyle = seconds !== null && seconds <= 10 ? '#e58a6b' : '#f6f5ef'
      ctx.fillText(clock, 64, h - 70)
    }
    this.screenTexture.needsUpdate = true
  }

  /**
   * Adaptive quality: if frames stay slow, step down (AO off, then pixel ratio 1) so weaker
   * machines stay smooth. Measured over about two seconds of frames.
   */
  private qualityLevel = 2
  private loadedAtFrame = 0
  private slowFrames = 0
  private adaptQuality(rawDt: number) {
    // Wait until models are loaded and shaders warmed up; loading frames are not representative.
    if (this.qualityLevel === 0 || this.loadedAtFrame === 0 || this.frame - this.loadedAtFrame < 180) return
    this.slowFrames = rawDt > 1 / 28 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 2)
    if (this.slowFrames < 60) return
    this.slowFrames = 0
    this.qualityLevel -= 1
    if (this.qualityLevel === 1 && this.outputs) {
      this.post.outputNode = this.outputs.light
      this.post.needsUpdate = true
    }
    if (this.qualityLevel === 0) {
      this.renderer.setPixelRatio(1)
      this.resize()
    }
    console.info('[boardroom] lowered render quality to level', this.qualityLevel)
  }

  private render() {
    const rawDt = this.clock.getDelta()
    const dt = Math.min(rawDt, 0.1)
    this.frame += 1
    this.adaptQuality(rawDt)
    const view = this.view
    const time = performance.now() / 1000
    const focusIndex = view?.focusId ? view.seats.findIndex((seat) => seat.id === view.focusId) : -1
    const focus = focusIndex >= 0 ? this.avatars[focusIndex] : null
    const focusHead = focus?.model ? focus.headPosition() : null
    this.animateHub(dt, time)
    // Everyone looks at whoever holds the floor: the agent's orb at the hub, or the member in focus.
    const lookTarget = view?.agent ? this.hubAnchor() : focusHead

    // What this window hears of the members' voices. While an agent holds the floor the playing audio is the
    // agent's, so no character's mouth may follow it.
    const voice = view?.agent ? null : readVoice()

    for (const avatar of this.avatars) {
      if (!avatar.mixer || !avatar.group.visible) continue
      avatar.animate(dt)
      avatar.updateFace(dt, time, voice)
      avatar.placeHands()
      const target = avatar === focus ? this.camera.position : lookTarget
      avatar.lookAt(target, dt, time)
    }

    // Presenter camera: glide to whoever is talking (a member or the hub agent) and back to the
    // overview between lines, unless the player is steering the camera themselves.
    if (performance.now() > this.userControlUntil) {
      const shot = view?.agent ? this.hubShot() : this.presenterShot(focus, focusHead)
      const k = 1 - Math.exp(-dt * 2.2)
      this.camera.position.lerp(shot.position, k)
      this.focus.lerp(shot.target, k)
      this.controls.target.copy(this.focus)
    } else {
      // Keep panning inside the room so the view cannot drift away from the table.
      const target = this.controls.target
      target.set(THREE.MathUtils.clamp(target.x, -5, 7.3), THREE.MathUtils.clamp(target.y, 0.2, 2.8), THREE.MathUtils.clamp(target.z, -3.4, 3.4))
      this.focus.copy(target)
    }
    this.controls.update()
    if (this.frame % 6 === 0) this.drawScreen()

    this.post.render()
    if (this.frame === 1) mark('first-frame')
    this.camera.updateMatrixWorld()
    const anchors = this.avatars.map((avatar) => (avatar.model && avatar.group.visible ? avatar.headPosition().add(new THREE.Vector3(0, 0.27, 0)) : null))
    anchors.push(view?.agent ? this.hubAnchor().add(new THREE.Vector3(0, 0.2, 0)) : null)
    this.tags.layout(anchors, this.camera, this.size.width, this.size.height)
  }

  /** Double click: back to the default view, and follow the speaker again. */
  private resetView() {
    this.userControlUntil = 0
    this.camera.position.set(6.4, 3.0, 0.0)
    this.focus.set(-0.4, 0.95, 0)
    this.controls.target.copy(this.focus)
  }

  /** Over Alex's shoulder toward the hub, with Morgan and Sam listening on either side. */
  private hubShot() {
    return { position: new THREE.Vector3(3.9, 2.3, -0.4), target: HUB_TOP.clone().add(new THREE.Vector3(-0.35, 0.1, 0)) }
  }

  /**
   * Camera pose for the current moment. With a speaker: across the table in front of them,
   * slightly to one side and above eye level, framing head and upper body (the speaker looks
   * into this camera). Without one: the overview from the end of the room.
   */
  private presenterShot(speaker: Avatar | null, head: THREE.Vector3 | null) {
    if (!speaker || !head) return { position: new THREE.Vector3(6.4, 3.0, 0), target: new THREE.Vector3(-0.4, 0.95, 0) }
    const toward = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, speaker.seat.yaw)
    const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(UP, speaker.seat.yaw)
    // Side seats: shift the camera away from the table centre so the hub never sits between it and the speaker.
    if (side.x * Math.sign(speaker.seat.position.x) < -0.1) side.negate()
    return {
      // Opposite seats are 1 m apart and directly across, so a 0.5 m side offset puts the camera
      // in the gap between two of them; the raised height clears the speaker's laptop lid.
      // Head and shoulders, close to eye level: the earlier higher, lower aimed shot filled half the frame with table.
      position: head.clone().addScaledVector(toward, 1.75).addScaledVector(side, 0.45).add(new THREE.Vector3(0, 0.2, 0)),
      target: head.clone().add(new THREE.Vector3(0, -0.12, 0)),
    }
  }
}

/** Sharper texture filtering and consistent PBR response for generated models. */
function tuneMaterial(material: THREE.MeshStandardMaterial, options: { roughness?: number; envMapIntensity?: number }) {
  if (!material?.isMeshStandardMaterial) return
  for (const map of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
    if (map) {
      map.anisotropy = 8
      map.needsUpdate = true
    }
  }
  if (options.roughness !== undefined) material.roughness = options.roughness
  material.envMapIntensity = options.envMapIntensity ?? 1
  material.needsUpdate = true
}

/** Opacity map that fades the light column out toward its top (drawn before upload, as WebGPU requires). */
function verticalFade() {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createLinearGradient(0, 0, 0, 128)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0)')
  gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.35)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 1)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 4, 128)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Opacity map for the glow on the table round the hub: strongest at the inner edge. */
function radialFade() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.9)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineHeight: number, maxLines: number) {
  const words = text.split(' ')
  let line = ''
  let lines = 0
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > width && line) {
      ctx.fillText(line, x, y + lines * lineHeight)
      line = word
      lines += 1
      if (lines === maxLines - 1) break
    } else {
      line = test
    }
  }
  if (line) ctx.fillText(line, x, y + lines * lineHeight)
}
