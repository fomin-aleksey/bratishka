// What keeps the robot alive between and during its words, per frame: where
// its head looks and how its shoulders follow, its breath, when it started
// and stopped talking (for the flash and the ebb), the microphone that lets
// the rings hear the person, and the fakes the demo modes show.

import { random } from './kinds.js'

/** How a neck turns the head to a new place: quick to start, easing in, no bounce to speak of. */
const NECK = { omega: 3.4, damping: 0.86 }
/** A nod with the words: quicker, a little springy. */
const NOD = { omega: 7, damping: 0.65 }
/** The shoulders come round after the head, slowly. */
const SHOULDERS = { omega: 1.6, damping: 1 }
/** Seconds a breath takes, and the share of it spent breathing in. */
const BREATH_SECONDS = 4.4
const INHALE = 0.38
/** Every so many breaths one is a sigh: deeper and slower. */
const SIGH_EVERY = [6, 11]

const between = (rnd, a, b) => a + (b - a) * rnd()
const either = rnd => (rnd() < 0.5 ? -1 : 1)
const ease = x => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)))

/** One step of a damped spring towards `target`: a new { x, v }. */
const spring = (s, target, dt, { omega, damping }) => {
  const v = s.v + (omega * omega * (target - s.x) - 2 * damping * omega * s.v) * dt
  return { x: s.x + v * dt, v }
}

/**
 * Where the head looks next and for how long, in radians and seconds, by
 * what the robot is doing. Yaw is to its left, pitch up, roll to its left.
 */
function nextGlance(rnd, mood) {
  if (mood === 'think') {
    // Thinking: up and away, the gaze wandering from place to place.
    return {
      yaw: either(rnd) * between(rnd, 0.12, 0.3),
      pitch: between(rnd, 0.07, 0.15),
      roll: between(rnd, -0.04, 0.04),
      hold: between(rnd, 1.4, 3.2),
    }
  }
  if (mood === 'speak') {
    // Speaking: at the person, shifting a little with the thought.
    return {
      yaw: between(rnd, -0.12, 0.12),
      pitch: between(rnd, -0.03, 0.04),
      roll: between(rnd, -0.03, 0.03),
      hold: between(rnd, 1.8, 3.8),
    }
  }
  // Listening: now and then a look aside...
  if (rnd() < 0.22) {
    return {
      yaw: either(rnd) * between(rnd, 0.18, 0.3),
      pitch: between(rnd, -0.05, 0.06),
      roll: between(rnd, -0.02, 0.02),
      hold: between(rnd, 1.2, 2.4),
    }
  }
  // ...but mostly at the person, the head a little to one side.
  return {
    yaw: between(rnd, -0.08, 0.08),
    pitch: between(rnd, -0.05, 0.01),
    roll: either(rnd) * between(rnd, 0.015, 0.06),
    hold: between(rnd, 3, 6.5),
  }
}

const moodOf = ({ think, speak }) => (think > 0.5 ? 'think' : speak > 0.5 ? 'speak' : 'listen')

/** How full the chest is at `phase` of a breath, 0 empty to 1 full: in quickly, out slowly. */
const lungs = phase => (phase < INHALE ? ease(phase / INHALE) : 1 - ease((phase - INHALE) / (1 - INHALE)))

/**
 * The robot's living motion, frame by frame. The head glances about: it
 * holds a while, then turns to a new place as a neck turns it, and where it
 * looks depends on what the robot is doing. Listening it faces the person
 * with its head a little to one side, thinking it looks up and away,
 * speaking it looks ahead and nods with its words. The shoulders come round
 * after the head and shift their weight; the chest breathes, now and then
 * with a sigh. Slow sines under it all keep it from ever standing still.
 *
 * `life(t, dt, { think, speak, level })`, each 0 to 1, returns
 * { head: [yaw, pitch, roll, breath], sway: [dx, dy, shoulder yaw, shoulder roll] };
 * breath is 0 to 1, up to 2 in a sigh. The same seed moves the same way.
 */
export function createLife(seed = 7) {
  const rnd = random(seed)
  let state = {
    yaw: { x: 0, v: 0 },
    pitch: { x: 0, v: 0 },
    roll: { x: 0, v: 0 },
    nod: { x: 0, v: 0 },
    shoulders: { x: 0, v: 0 },
    glance: { yaw: 0, pitch: 0, roll: 0, hold: 1 },
    until: 0.6,
    mood: 'listen',
    phase: 0.6,
    sigh: false,
    sighIn: Math.round(between(rnd, 2, 4)),
  }

  return (t, dt, input) => {
    const mood = moodOf(input)
    let { glance, until, phase, sigh, sighIn } = state
    // A change of what it is doing turns the head soon, not when the glance runs out.
    if (mood !== state.mood) until = Math.min(until, t + between(rnd, 0.15, 0.5))
    if (t >= until) {
      glance = nextGlance(rnd, mood)
      until = t + glance.hold
    }

    phase += dt / (BREATH_SECONDS * (sigh ? 1.6 : 1))
    if (phase >= 1) {
      phase -= 1
      sighIn -= 1
      sigh = sighIn <= 0
      if (sigh) sighIn = Math.round(between(rnd, ...SIGH_EVERY))
    }
    const breath = lungs(phase) * (sigh ? 2 : 1)

    const nod = spring(state.nod, -0.05 * input.level * input.speak, dt, NOD)
    const yaw = spring(state.yaw, glance.yaw, dt, NECK)
    const pitch = spring(state.pitch, glance.pitch, dt, NECK)
    const roll = spring(state.roll, glance.roll, dt, NECK)
    const shoulders = spring(state.shoulders, 0.35 * yaw.x, dt, SHOULDERS)
    state = { yaw, pitch, roll, nod, shoulders, glance, until, mood, phase, sigh, sighIn }

    // Breathing in, the head rises a little and tips back.
    const head = [
      yaw.x + 0.022 * Math.sin(t * 0.37 + 1.3) + 0.012 * Math.sin(t * 0.83),
      pitch.x + nod.x + 0.012 * Math.sin(t * 0.29 + 0.4) + 0.012 * breath,
      roll.x + 0.008 * Math.sin(t * 0.31 + 0.7) + 0.004 * Math.sin(t * 0.77 + 2.1),
      breath,
    ]
    const sway = [
      0.0028 * Math.sin(t * 0.25 + 0.4),
      0.0015 * Math.sin(t * 0.9 - 0.6) + 0.0035 * breath,
      shoulders.x,
      0.3 * roll.x + 0.01 * Math.sin(t * 0.17 + 2.4),
    ]
    return { head, sway }
  }
}

/**
 * Whether the robot is talking: from the first word to `hold` seconds after
 * the last, so the pauses between its sentences do not count as silence.
 * `talk(t, speaking)` also says how long ago it started (onset) and stopped
 * (offset), long ago when it never did.
 */
export function createTalk(hold = 0.6) {
  let talking = false
  let heard = -1e9
  let started = -1e9
  let stopped = -1e9
  return (t, speaking) => {
    if (speaking) heard = t
    const now = speaking || t - heard < hold
    if (now && !talking) started = t
    if (!now && talking) stopped = t
    talking = now
    return { talking, onset: t - started, offset: t - stopped }
  }
}

/** One swell of a beat `s` seconds after it, rising fast and dying away: 0 to 1, 1 at its top. */
const swell = s => (s > 0 ? (s / 0.06) * Math.exp(1 - s / 0.06) : 0)

/**
 * How full the heart's glow is `since` seconds after the monitor's last
 * beat, 0 to 1: the first sound of the beat, then a smaller second one.
 */
export const pulseAt = since => Math.min(1, swell(since) + 0.55 * swell(since - 0.24))

/** A made-up voice of the person for the demos: phrases with pauses, 0 to 1. */
export const fakeVoice = t => {
  const phrase = Math.max(0, Math.sin(t * 1.3)) > 0.25 ? 1 : 0
  return phrase * Math.min(1, Math.max(0, 0.45 + 0.4 * Math.sin(t * 11) * Math.sin(t * 3.7)))
}

/**
 * What ?demo=cycle shows at `t` seconds, round and round: listening while
 * the person speaks, thinking, then speaking.
 */
export function demoCycle(t) {
  const at = t % 17
  if (at < 5) return { speaking: false, thinking: false, mic: at > 1 && at < 4.2 ? fakeVoice(at) : 0 }
  if (at < 10) return { speaking: false, thinking: true, mic: 0 }
  return { speaking: true, thinking: false, mic: 0 }
}

/** The calls ?demo=cycle makes while it thinks, at seconds into its round: one of them fails. */
const DEMO_CALLS = [
  { at: 5.6, tool: 'Read', detail: 'robot.js' },
  { at: 6.4, tool: 'Grep', detail: 'orbitAt' },
  { at: 7.2, tool: 'Bash', detail: 'Run the mod tests' },
  { at: 8.1, tool: 'Edit', detail: 'head.js', fails: true },
]

/** The demo's calls starting or ending between `from` and `to` seconds, as the server sends them. */
export function demoCalls(from, to) {
  const out = []
  const round = Math.floor(to / 17)
  const crossed = at => from % 17 < at && to % 17 >= at && Math.floor(from / 17) === round
  DEMO_CALLS.forEach((call, i) => {
    const id = `demo-${round}-${i}`
    const at = Date.now() / 1000
    const base = { id, tool: call.tool, detail: call.detail, sub: false, at }
    if (crossed(call.at)) out.push({ ...base, state: 'run' })
    if (crossed(call.at + 0.5)) out.push({ ...base, state: call.fails ? 'fail' : 'ok' })
  })
  return out
}

/** The figures the demos show. */
export const DEMO_VITALS = {
  context: 38,
  limits: [
    { kind: 'five_hour', used: 34 },
    { kind: 'seven_day', used: 12 },
  ],
  usd: 3.42,
  ageMs: 5_025_000,
  model: 'claude-opus-5-5',
}

/**
 * The person's microphone, open only while the window is in front: what the
 * rings and the temples hear while the robot listens. Nothing is recorded or
 * sent anywhere: only its loudness is read, frame by frame. `level()` is 0
 * to 1; `onDenied` hears once if the browser refuses it.
 */
export function createMic(context, onDenied) {
  const mic = { stream: null, source: null, analyser: null, data: null, opening: false, denied: false }

  const close = () => {
    if (!mic.stream) return
    for (const track of mic.stream.getTracks()) track.stop()
    mic.source.disconnect()
    Object.assign(mic, { stream: null, source: null, analyser: null, data: null })
  }

  const open = async () => {
    const ctx = context()
    if (mic.stream || mic.opening || mic.denied || !ctx || !navigator.mediaDevices?.getUserMedia) return
    mic.opening = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      // The window went to the back while the browser was asking.
      if (!document.hasFocus()) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      Object.assign(mic, { stream, source, analyser, data: new Float32Array(analyser.fftSize) })
    } catch (error) {
      mic.denied = true
      onDenied(error)
    } finally {
      mic.opening = false
    }
  }

  const level = () => {
    if (!mic.analyser) return 0
    mic.analyser.getFloatTimeDomainData(mic.data)
    let sum = 0
    for (const sample of mic.data) sum += sample * sample
    return Math.min(1, Math.max(0, (Math.sqrt(sum / mic.data.length) - 0.012) * 9))
  }

  return { open, close, level }
}
