// What keeps the robot alive between and during its words, per frame: the
// head's idle sway, when it started and stopped talking (for the flash and
// the ebb), the microphone that lets the rings hear the person, and the
// fakes the demo modes show.

/**
 * The head's idle sway at `t` seconds: [yaw, roll, dx, dy]. Sums of slow
 * sines that never quite repeat, as a man's head moves standing still.
 */
export function headPose(t) {
  const yaw = 0.085 * Math.sin(t * 0.21) + 0.035 * Math.sin(t * 0.57 + 1.3)
  const roll = 0.011 * Math.sin(t * 0.29 + 0.7) + 0.005 * Math.sin(t * 0.77 + 2.1)
  const dx = 0.0028 * Math.sin(t * 0.25 + 0.4)
  const dy = 0.002 * Math.sin(t * 0.9 - 0.6)
  return [yaw, roll, dx, dy]
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
