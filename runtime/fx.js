// The glitch on a failure: the scene's compose pass tears the picture and
// splits its colors, this says how strong the glitch is from frame to frame
// and crackles with static as it starts, a sound made on the spot with Web
// Audio, no files. Failed tests glitch harder and longer than a failed call.

/** How long a glitch lasts and how strong it is: a failed call, failed tests. */
const GLITCHES = { call: { seconds: 0.75, strength: 0.6 }, test: { seconds: 1.6, strength: 1 } }
/** How loud the static is, against the voice. */
const VOLUME = 0.5

/** A repeatable pseudo-random number for `n`, 0 to 1: the same flicker on every run of a render. */
const hash = n => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Static crackling for `seconds` on `context`: bursts of filtered noise and a falling buzz. */
const crackle = (context, seconds, strength) => {
  const now = context.currentTime
  const length = Math.round(context.sampleRate * seconds)
  const noise = context.createBuffer(1, length, context.sampleRate)
  const data = noise.getChannelData(0)
  // On and off in bursts a few hundredths of a second long.
  let on = 1
  for (let i = 0; i < length; i++) {
    if (i % 900 === 0) on = Math.random() < 0.65 ? 1 : 0.1
    data[i] = (Math.random() * 2 - 1) * on * (1 - (i / length) ** 2)
  }
  const source = context.createBufferSource()
  source.buffer = noise
  const band = context.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 2200
  band.Q.value = 0.7
  const level = context.createGain()
  level.gain.value = 0.35 * strength * VOLUME
  source.connect(band).connect(level).connect(context.destination)
  source.start(now)
  const buzz = context.createOscillator()
  buzz.type = 'square'
  buzz.frequency.setValueAtTime(220, now)
  buzz.frequency.exponentialRampToValueAtTime(55, now + Math.min(0.5, seconds))
  const hum = context.createGain()
  hum.gain.setValueAtTime(0.05 * strength * VOLUME, now)
  hum.gain.exponentialRampToValueAtTime(0.0001, now + Math.min(0.5, seconds))
  buzz.connect(hum).connect(context.destination)
  buzz.start(now)
  buzz.stop(now + Math.min(0.5, seconds))
}

/**
 * The glitch, with its static on the context `audio()` returns (none while
 * it is missing or suspended). `fail(t, tests)` starts one, a strong one when
 * tests failed; `frame(t)` answers how strong it is now, 0 to 1: strongest at
 * once, dying away, flickering on and off. Times in seconds.
 */
export function createFx(audio) {
  let glitch = { at: -1e9, ...GLITCHES.call }

  return {
    fail(t, tests) {
      glitch = { at: t, ...(tests ? GLITCHES.test : GLITCHES.call) }
      const context = audio()
      if (context && context.state === 'running') crackle(context, glitch.seconds, glitch.strength)
    },
    frame(t) {
      const age = t - glitch.at
      const left = 1 - age / glitch.seconds
      const flicker = hash(Math.floor(age * 15) + glitch.at) > 0.3 ? 1 : 0.35
      return age >= 0 && left > 0 ? glitch.strength * Math.sqrt(left) * flicker : 0
    },
  }
}

/** Whether a call that ended failed, and whether it was tests that failed: null when it did not fail. */
export const failureOf = call => (call.state === 'fail' ? { tests: call.kind === 'test' } : null)
