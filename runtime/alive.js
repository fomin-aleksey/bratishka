// What keeps the robot alive between and during its words, per frame: where
// its head looks and how its shoulders follow, its breath, its yawns, its
// sleep and its starts, its mood while nobody needs it, when it started and
// stopped talking (for the flash and the ebb), the microphone that lets the
// rings hear the person, and the fakes the demo modes show.

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
/** A yawn's length, and how often one comes while the robot is bored, in seconds. */
const YAWN_SECONDS = 3.8
const YAWN_EVERY = [22, 45]
/** Asleep, the head hangs forward and to one side, and a breath takes this many times as long. */
const DROOP = { yaw: 0.04, pitch: -0.27, roll: 0.09 }
const SLEEP_BREATH = 1.7
/** How long the chest stays puffed up with pride, in seconds. */
const PRIDE_SECONDS = 3.6

const between = (rnd, a, b) => a + (b - a) * rnd()
const either = rnd => (rnd() < 0.5 ? -1 : 1)
const ease = x => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)))
const mix = (a, b, k) => a + (b - a) * k

/** How far into a gesture `s` seconds after it began, 0 to 1: up over `rise`, held, down by `length`. */
const swellOf = (s, rise, hold, length) =>
  s < 0 || s > length ? 0 : s < rise ? ease(s / rise) : s < hold ? 1 : 1 - ease((s - hold) / (length - hold))

/** A jolt `s` seconds after a start: at once, dying away in a fraction of a second. */
const jolt = s => (s >= 0 ? Math.exp(-s * 9) : 0)

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
  if (mood === 'bored') {
    // Bored: looking about the room at nothing in particular, and down.
    return {
      yaw: either(rnd) * between(rnd, 0.1, 0.32),
      pitch: between(rnd, -0.12, 0.05),
      roll: between(rnd, -0.05, 0.05),
      hold: between(rnd, 2, 5),
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

const moodOf = ({ think, speak, bored = 0 }) =>
  think > 0.5 ? 'think' : speak > 0.5 ? 'speak' : bored > 0.5 ? 'bored' : 'listen'

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
 * Bored, it looks about and yawns now and then, the head thrown back on a
 * long breath in; asleep, its head hangs and it breathes slow and deep.
 * Woken, it starts: the head snaps up and glances round. A failure makes it
 * flinch; praise puffs its chest up and tips its head back, pleased.
 *
 * `life(t, dt, { think, speak, level, bored, sleep, wakeAt, flinchAt, prideAt })`:
 * the first five 0 to 1, the last three when those last happened, in the
 * same seconds as `t`. Returns { head: [yaw, pitch, roll, breath], sway:
 * [dx, dy, shoulder yaw, shoulder roll] }; breath is 0 to 1, more in a sigh
 * or a yawn. The same seed moves the same way. `yawnEvery` is how many
 * seconds pass between yawns, [least, most].
 */
export function createLife(seed = 7, { yawnEvery = YAWN_EVERY } = {}) {
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
    yawnAt: -1e9,
    yawnSide: 1,
    nextYawn: Infinity,
    // The starts it has already answered, so each one kicks the head once.
    woke: -1e9,
    flinched: -1e9,
  }

  return (t, dt, input) => {
    const mood = moodOf(input)
    const asleep = input.sleep ?? 0
    const wakeAt = input.wakeAt ?? -1e9
    const flinchAt = input.flinchAt ?? -1e9
    const prideAt = input.prideAt ?? -1e9
    let { glance, until, phase, sigh, sighIn, yawnAt, yawnSide, nextYawn } = state
    let { yaw, pitch, roll } = state
    // A change of what it is doing turns the head soon, not when the glance runs out.
    if (mood !== state.mood) until = Math.min(until, t + between(rnd, 0.15, 0.5))
    if (t >= until) {
      glance = nextGlance(rnd, mood)
      until = t + glance.hold
    }

    // Woken with a start: the head snaps up and glances aside before it settles.
    if (wakeAt > state.woke) {
      pitch = { ...pitch, v: pitch.v + 3.4 }
      yaw = { ...yaw, v: yaw.v + either(rnd) * 2.2 }
      glance = { yaw: either(rnd) * between(rnd, 0.16, 0.28), pitch: 0.06, roll: 0, hold: 0.7 }
      until = t + glance.hold
    }
    // A failure: a flinch, the head jerked back and shaken.
    if (flinchAt > state.flinched) {
      pitch = { ...pitch, v: pitch.v + 2.6 }
      roll = { ...roll, v: roll.v + either(rnd) * 1.6 }
      yaw = { ...yaw, v: yaw.v + either(rnd) * 1.2 }
    }

    // Bored, a yawn every so often; the first one soon.
    if (input.bored > 0.5 && asleep < 0.1 && input.think < 0.5 && input.speak < 0.5) {
      if (nextYawn === Infinity) nextYawn = t + between(rnd, yawnEvery[0] * 0.25, yawnEvery[0] * 0.6)
      if (t >= nextYawn) {
        yawnAt = t
        yawnSide = either(rnd)
        nextYawn = t + between(rnd, ...yawnEvery)
      }
    } else {
      nextYawn = Infinity
    }
    const yawn = swellOf(t - yawnAt, 1.3, 2.3, YAWN_SECONDS)
    const puff = swellOf(t - prideAt, 0.5, 2.4, PRIDE_SECONDS)

    phase += dt / (BREATH_SECONDS * (sigh ? 1.6 : 1) * mix(1, SLEEP_BREATH, asleep))
    if (phase >= 1) {
      phase -= 1
      sighIn -= 1
      sigh = sighIn <= 0
      if (sigh) sighIn = Math.round(between(rnd, ...SIGH_EVERY))
    }
    // A yawn and pride fill the chest past any breath.
    const breath = Math.max(lungs(phase) * (sigh ? 2 : 1) * mix(1, 1.35, asleep), 2.5 * yawn, 1.8 * puff)

    // Asleep the head hangs wherever it was looking.
    const nod = spring(state.nod, -0.05 * input.level * input.speak, dt, NOD)
    yaw = spring(yaw, mix(glance.yaw, DROOP.yaw, asleep), dt, NECK)
    pitch = spring(pitch, mix(glance.pitch, DROOP.pitch, asleep), dt, NECK)
    roll = spring(roll, mix(glance.roll, DROOP.roll, asleep), dt, NECK)
    const shoulders = spring(state.shoulders, 0.35 * yaw.x, dt, SHOULDERS)
    state = {
      yaw,
      pitch,
      roll,
      nod,
      shoulders,
      glance,
      until,
      mood,
      phase,
      sigh,
      sighIn,
      yawnAt,
      yawnSide,
      nextYawn,
      woke: Math.max(state.woke, wakeAt),
      flinched: Math.max(state.flinched, flinchAt),
    }

    // Breathing in, the head rises a little and tips back; a yawn throws it
    // back and to one side, pride lifts it and rocks it a little.
    const start = jolt(t - Math.max(wakeAt, flinchAt))
    const head = [
      yaw.x + 0.022 * Math.sin(t * 0.37 + 1.3) + 0.012 * Math.sin(t * 0.83),
      pitch.x + nod.x + 0.012 * Math.sin(t * 0.29 + 0.4) + 0.012 * breath + 0.3 * yawn + 0.09 * puff,
      roll.x +
        0.008 * Math.sin(t * 0.31 + 0.7) +
        0.004 * Math.sin(t * 0.77 + 2.1) +
        0.07 * yawn * yawnSide +
        0.035 * puff * Math.sin(t * 4.2),
      breath,
    ]
    // A start shakes the whole bust for a moment; a yawn and pride lift the shoulders.
    const sway = [
      0.0028 * Math.sin(t * 0.25 + 0.4) + 0.006 * start * Math.sin(t * 70),
      0.0015 * Math.sin(t * 0.9 - 0.6) + 0.0035 * breath + 0.012 * start + 0.008 * yawn + 0.006 * puff,
      shoulders.x,
      0.3 * roll.x + 0.01 * Math.sin(t * 0.17 + 2.4),
    ]
    return { head, sway }
  }
}

/** After this long with nothing to do the robot gets bored, after this long it falls asleep, in seconds. */
export const BORED_AFTER = 180
export const SLEEP_AFTER = 600
/** How long a start out of sleep and pride show as its state, in seconds. */
const WAKE_SECONDS = 2.6
const PROUD_SECONDS = 4

/**
 * The robot's mood while nobody needs it. `poke(t)` says the person or the
 * work stirred: it wakes a sleeping robot with a start. `praise(t)` makes it
 * proud a while. `frame(t, dt, busy)`, busy while it talks, thinks, works or
 * hears the person, answers how bored and how asleep it is (0 to 1, eased:
 * it nods off slowly and wakes at once), when it last woke and was praised,
 * and its state while nothing else shows: 'wake', 'proud', 'sleep', 'bored'
 * or null. All in the seconds of `t`.
 */
export function createMood({ boredAfter = BORED_AFTER, sleepAfter = SLEEP_AFTER } = {}) {
  let active = 0
  let wakeAt = -1e9
  let prideAt = -1e9
  let bored = 0
  let sleep = 0
  const poke = t => {
    if (sleep > 0.3 && t - wakeAt > WAKE_SECONDS) wakeAt = t
    active = t
  }
  return {
    poke,
    praise(t) {
      poke(t)
      prideAt = t
    },
    frame(t, dt, busy) {
      if (busy) poke(t)
      const idle = t - active
      const sleepy = idle >= sleepAfter ? 1 : 0
      const dull = idle >= boredAfter ? 1 : 0
      sleep += (sleepy - sleep) * Math.min(1, dt * (sleepy ? 0.35 : 6))
      bored += (dull - bored) * Math.min(1, dt * (dull ? 1 : 6))
      const rest =
        t - wakeAt < WAKE_SECONDS ? 'wake' : t - prideAt < PROUD_SECONDS ? 'proud' : sleepy ? 'sleep' : dull ? 'bored' : null
      return { bored, sleep, wakeAt, prideAt, rest }
    },
  }
}

/** Words of praise in the person's message: it makes the robot proud. */
const PRAISE = /(заеб[иа]сь|охуенн|отлично|молодец|красав|супер|класс|круто|огонь|пушка|шикарн|умница|good job|great|awesome|nice)/i
/** Praise is short: a long message that happens to say «круто» is a task, not praise. */
export const isPraise = text => String(text || '').length < 160 && PRAISE.test(String(text || ''))

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

/**
 * What ?demo=events makes up between `from` and `to` seconds, round and round
 * every 20: a call that fails, tests that fail, and praise from the person.
 * Calls as the server sends them; praise as { praise: text }.
 */
const DEMO_EVENTS = [
  { at: 3, tool: 'Read', detail: 'missing.js', kind: '', ends: 'fail' },
  { at: 8, tool: 'Bash', detail: 'Run the mod tests', kind: 'test', ends: 'fail' },
  { at: 14, praise: 'Слушай, ну заебись!' },
]

export function demoEvents(from, to) {
  const out = []
  const round = Math.floor(to / 20)
  const crossed = at => from % 20 < at && to % 20 >= at && Math.floor(from / 20) === round
  DEMO_EVENTS.forEach((one, i) => {
    if (one.praise) {
      if (crossed(one.at)) out.push({ praise: one.praise })
      return
    }
    const base = { id: `fx-${round}-${i}`, tool: one.tool, detail: one.detail, kind: one.kind, sub: false, at: Date.now() / 1000 }
    if (crossed(one.at - 0.6)) out.push({ ...base, state: 'run' })
    if (crossed(one.at)) out.push({ ...base, state: one.ends })
  })
  return out
}

/** The figures the demos show. */
export const DEMO_VITALS = {
  context: 38,
  tokens: 380_000,
  window: 1_000_000,
  limits: [
    { kind: 'five_hour', used: 34, resets: Date.now() / 1000 + 8040 },
    { kind: 'seven_day', used: 12, resets: Date.now() / 1000 + 273_600 },
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
