// The robot's voice: Silero's speech run through a chain of Web Audio
// effects in the window, so it sounds like a machine and not a newsreader.
// The pitch drops by a few semitones, an octave below thickens it, a comb
// filter rings like a metal hull, a little drive roughens it and a short
// metallic room closes round it. Every effect is plain nodes, no worklet, so
// the same chain runs live and in an OfflineAudioContext; it adds a few tens
// of milliseconds at most.
//
// VOICES are the presets, each with the gain that brings it back to the
// plain voice's loudness; createVoiceFx(ctx, name) builds one: connect the
// speech to `input` and take the voice from `output`.

export const VOICES = {
  optimus: {
    title: 'Оптимус',
    pitch: -4,
    octave: 0.32,
    comb: { ms: 7, feedback: 0.35, mix: 0.3 },
    drive: 0.15,
    room: { seconds: 0.6, mix: 0.16 },
    eq: { low: 4, presence: 3 },
    gain: 0.42,
  },
  megatron: {
    title: 'Мегатрон',
    pitch: -6,
    octave: 0.22,
    comb: { ms: 4.5, feedback: 0.5, mix: 0.35 },
    ring: { hz: 55, depth: 0.45 },
    drive: 0.45,
    room: { seconds: 0.9, mix: 0.2 },
    eq: { low: 3, presence: 4 },
    gain: 0.4,
  },
  bumblebee: {
    title: 'Бамблби',
    pitch: 1,
    ring: { hz: 30, depth: 0.25 },
    drive: 0.35,
    radio: true,
    gain: 0.49,
  },
  vocoder: {
    title: 'Вокодер',
    pitch: -2,
    ring: { hz: 90, depth: 0.8 },
    comb: { ms: 10, feedback: 0.6, mix: 0.5 },
    flanger: { ms: 3, depth: 2, hz: 0.3, feedback: 0.5, mix: 0.5 },
    drive: 0.1,
    room: { seconds: 0.5, mix: 0.14 },
    gain: 0.83,
  },
  metal: {
    title: 'Лёгкий металл',
    pitch: -2,
    comb: { ms: 6, feedback: 0.25, mix: 0.22 },
    drive: 0.05,
    room: { seconds: 0.4, mix: 0.12 },
    gain: 0.75,
  },
}

/** A one-channel buffer `seconds` long, sample i = shape(i / length). */
const shaped = (ctx, seconds, shape) => {
  const n = Math.max(2, Math.round(seconds * ctx.sampleRate))
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < n; i++) data[i] = shape(i / n)
  return buffer
}

/** `buffer` looping from `offset` seconds into it, `scale` of it driving `param`. */
const drive = (ctx, buffer, offset, param, scale) => {
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = true
  const gain = ctx.createGain()
  gain.gain.value = scale
  source.connect(gain).connect(param)
  source.start(ctx.currentTime, offset)
}

const gainOf = (ctx, value) => {
  const gain = ctx.createGain()
  gain.gain.value = value
  return gain
}

/**
 * Shifts the pitch by `semitones` without changing the pace: two taps read
 * the speech through delays that grow (or shrink) steadily, each jumping
 * back while it is faded out, the other fading in, half a cycle apart.
 * The slight warble it leaves suits a machine.
 */
function pitchShift(ctx, semitones) {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const slope = 1 - 2 ** (semitones / 12)
  const most = 0.06
  const period = most / Math.abs(slope)
  const ramp = shaped(ctx, period, x => (slope > 0 ? x : 1 - x))
  const fade = shaped(ctx, period, x => Math.sin(Math.PI * x) ** 2)
  for (const offset of [0, period / 2]) {
    const delay = ctx.createDelay(1)
    delay.delayTime.value = 0
    const tap = gainOf(ctx, 0)
    drive(ctx, ramp, offset, delay.delayTime, most)
    drive(ctx, fade, offset, tap.gain, 1)
    input.connect(delay).connect(tap).connect(output)
  }
  return { input, output }
}

/** A comb filter: a short delay fed back on itself, ringing like a metal pipe. */
function comb(ctx, { ms, feedback }) {
  const delay = ctx.createDelay(0.1)
  delay.delayTime.value = ms / 1000
  delay.connect(gainOf(ctx, feedback)).connect(delay)
  return { input: delay, output: delay }
}

/** A flanger: a delay swept by a slow wave, fed back. */
function flanger(ctx, { ms, depth, hz, feedback }) {
  const delay = ctx.createDelay(0.1)
  delay.delayTime.value = ms / 1000
  const wave = ctx.createOscillator()
  wave.frequency.value = hz
  wave.connect(gainOf(ctx, depth / 1000)).connect(delay.delayTime)
  wave.start()
  delay.connect(gainOf(ctx, feedback)).connect(delay)
  return { input: delay, output: delay }
}

/** Ring modulation: the voice times a low sine, `depth` of it, the buzz of a speaker grille. */
function ring(ctx, { hz, depth }) {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const modulated = gainOf(ctx, 0)
  const sine = ctx.createOscillator()
  sine.frequency.value = hz
  sine.connect(modulated.gain)
  sine.start()
  input.connect(gainOf(ctx, 1 - depth)).connect(output)
  input.connect(modulated).connect(gainOf(ctx, depth)).connect(output)
  return { input, output }
}

/** Soft clipping, `amount` 0 to 1. */
function overdrive(ctx, amount) {
  const shaper = ctx.createWaveShaper()
  const k = 1 + amount * 12
  const curve = new Float32Array(2048)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / Math.tanh(k)
  }
  shaper.curve = curve
  shaper.oversample = '4x'
  return shaper
}

/** A small metal room: decaying noise with a few resonances ringing in it. */
function room(ctx, seconds) {
  const convolver = ctx.createConvolver()
  const n = Math.round(seconds * ctx.sampleRate)
  const impulse = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel)
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate
      const ringing = 1 + 0.5 * Math.sin(2 * Math.PI * 830 * t) + 0.35 * Math.sin(2 * Math.PI * 1370 * t + channel)
      data[i] = (Math.random() * 2 - 1) * Math.exp(-t / (seconds * 0.28)) * ringing
    }
  }
  convolver.buffer = impulse
  return convolver
}

const filter = (ctx, type, frequency, { gain = 0, q = 0.7 } = {}) => {
  const node = ctx.createBiquadFilter()
  node.type = type
  node.frequency.value = frequency
  node.gain.value = gain
  node.Q.value = q
  return node
}

/** Nodes in a row: each into the next; the first and the last. */
const series = nodes => {
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i])
  return { input: nodes[0], output: nodes[nodes.length - 1] }
}

/** The voice `name` (see VOICES) on `ctx`: speech into `input`, the robot's voice out of `output`. */
export function createVoiceFx(ctx, name) {
  const voice = VOICES[name]
  const input = ctx.createGain()
  const output = ctx.createGain()
  if (!voice) {
    input.connect(output)
    return { input, output }
  }

  // The voice lowered, and an octave under it for weight.
  const body = ctx.createGain()
  const lowered = voice.pitch ? pitchShift(ctx, voice.pitch) : null
  if (lowered) {
    input.connect(lowered.input)
    lowered.output.connect(body)
  } else {
    input.connect(body)
  }
  const mix = ctx.createGain()
  body.connect(mix)
  if (voice.octave) {
    const under = pitchShift(ctx, voice.pitch - 12)
    input.connect(under.input)
    under.output.connect(gainOf(ctx, voice.octave)).connect(mix)
  }
  // The hull's ring, and the sweep of a flanger.
  for (const [make, settings] of [
    [comb, voice.comb],
    [flanger, voice.flanger],
  ]) {
    if (!settings) continue
    const effect = make(ctx, settings)
    body.connect(effect.input)
    effect.output.connect(gainOf(ctx, settings.mix)).connect(mix)
  }

  // The grille's buzz, the drive and the tone.
  let tail = mix
  if (voice.ring) {
    const buzz = ring(ctx, voice.ring)
    tail.connect(buzz.input)
    tail = buzz.output
  }
  const tone = voice.radio
    ? [filter(ctx, 'highpass', 320, { q: 0.9 }), filter(ctx, 'lowpass', 3400, { q: 0.9 }), filter(ctx, 'peaking', 1400, { gain: 6, q: 1 })]
    : [
        filter(ctx, 'highpass', 70),
        filter(ctx, 'lowshelf', 220, { gain: voice.eq?.low ?? 0 }),
        filter(ctx, 'peaking', 2600, { gain: voice.eq?.presence ?? 0, q: 0.9 }),
      ]
  const colored = series([...(voice.drive ? [overdrive(ctx, voice.drive)] : []), ...tone])
  tail.connect(colored.input)

  // The room, a compressor to keep the level even whatever the chain did, the
  // preset's gain back to the plain voice's loudness and a limiter after it.
  const level = ctx.createDynamicsCompressor()
  level.threshold.value = -20
  level.ratio.value = 4
  level.attack.value = 0.005
  level.release.value = 0.15
  colored.output.connect(level)
  if (voice.room) {
    const hall = room(ctx, voice.room.seconds)
    colored.output.connect(hall).connect(gainOf(ctx, voice.room.mix)).connect(level)
  }
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -3
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.08
  level.connect(gainOf(ctx, voice.gain ?? 1)).connect(limiter).connect(output)
  return { input, output }
}
