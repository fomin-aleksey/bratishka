// The stage around the figure: mountain ranges of points either side of it,
// seen from a little above, rivers of light running down their slopes and
// sparkles on their crests; concentric rings round the head that ripple
// while the robot listens; a little dust.
//
// Every mountain, river and sparkle point keeps its base and its height
// apart; the shader puts it at its place and lets it drift there on a clock
// of its own. The stage does not listen to the voice.

import { KIND, smooth, variety } from './kinds.js'
import { insideFigure } from './figure.js'

const hash2 = (i, j, seed) => {
  const s = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453
  return s - Math.floor(s)
}

const noise2 = (x, y, seed) => {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const fx = x - i
  const fy = y - j
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(i, j, seed)
  const b = hash2(i + 1, j, seed)
  const c = hash2(i, j + 1, seed)
  const d = hash2(i + 1, j + 1, seed)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** Smooth fractal noise in [0, 1]. */
const fbm2 = (x, y, seed) => {
  let sum = 0
  let amp = 0.55
  let norm = 0
  for (let o = 0; o < 4; o++) {
    sum += noise2(x, y, seed + o * 3.1) * amp
    norm += amp
    amp *= 0.5
    x *= 2.03
    y *= 2.03
  }
  return sum / norm
}

/** Ridged fractal noise in [0, 1]: sharp crests, like mountain ranges. */
const ridged2 = (x, y, seed) => {
  let sum = 0
  let amp = 0.6
  let freq = 1
  let norm = 0
  let weight = 1
  for (let o = 0; o < 5; o++) {
    let r = 1 - Math.abs(noise2(x * freq, y * freq, seed + o * 7.3) * 2 - 1)
    r = r * r * weight
    weight = Math.min(1, r * 1.6)
    sum += r * amp
    norm += amp
    amp *= 0.5
    freq *= 2.05
  }
  return sum / norm
}

/** Where the farthest range stands on the screen: a little below the chin. */
const HORIZON = 0.03
const ROWS = 230
/** The levels of the slow field whose crossings are the rivers. */
const RIVERS = [0.3, 0.4, 0.5, 0.6, 0.7]

/**
 * The ranges, row by row from near (low on the screen) to far (up at the
 * horizon). A row's points sample one depth of the terrain, far rows
 * squeezed sideways as perspective squeezes them. A skyline remembers how
 * high the nearer rows reached: a point below it is hidden and mostly
 * dropped, so the far ranges show only above the near ones.
 */
function buildMountains(rnd, push, extent, bottom) {
  const BIN = 0.004
  const bins = Math.ceil((2 * extent) / BIN) + 2
  const skyline = new Float32Array(bins).fill(-10)
  const binOf = x => Math.max(0, Math.min(bins - 1, Math.floor((x + extent) / BIN)))
  for (let r = ROWS - 1; r >= 0; r--) {
    const z = r / (ROWS - 1)
    const depth = 1 / (0.22 + 0.78 * z)
    const base = HORIZON - (HORIZON - bottom) * z
    const amp = 0.3 + 0.08 * (1 - z)
    const tops = []
    const crossed = RIVERS.map(() => null)
    for (let x = -extent; x < extent; x += 0.0021 * (0.7 + rnd() * 0.6)) {
      const tx = x * depth * 0.95 + 13
      const tz = depth * 1.1
      // Broad massifs under sharp crests.
      const crest = ridged2(tx * 1.6, tz * 1.6, 7)
      const massif = smooth(0.3, 0.75, fbm2(tx * 0.7, tz * 0.7, 19))
      const shape = 0.35 * massif + 0.9 * Math.pow(crest, 1.4)
      const h = amp * shape * (0.8 + 0.2 * smooth(0.25, 0.9, Math.abs(x)))
      const top = base + h
      tops.push([x, top])
      const flow = fbm2(tx * 0.9, tz * 0.9, 31)
      const sides = RIVERS.map(level => flow > level)
      const rivers = sides.filter((side, i) => crossed[i] !== null && crossed[i] !== side).length
      sides.forEach((side, i) => (crossed[i] = side))
      if (insideFigure(x, top)) continue
      const hidden = top < skyline[binOf(x)] - 0.002
      if (hidden && rnd() > 0.07) continue
      const glow = smooth(0.2, 0.8, crest)
      push(x, base, 0, h, z, glow, KIND.mountain, (0.85 + 0.45 * z) * variety(rnd), hidden ? 0.3 : 1)
      if (hidden) continue
      // The slope just under the crest, a share of its height.
      if (rnd() < 0.6) {
        const k = 1 - rnd() * rnd() * 0.3
        push(x + (rnd() - 0.5) * 0.002, base, 0, h * k, z, glow * 0.55, KIND.mountain, (0.8 + 0.4 * z) * variety(rnd), 0.8)
      }
      for (let k = 0; k < rivers * 4; k++) {
        const dx = (rnd() - 0.5) * 0.003
        const strength = (0.5 + 0.5 * z) * (0.75 + 0.25 * rnd())
        push(x + dx, base, 0, h, z, x * 3 + z * 5, KIND.river, 1.25 * variety(rnd), strength)
      }
      if (glow > 0.4 && rnd() < 0.03) {
        push(x, base, 0, h, z, glow, KIND.sparkle, (1.4 + 0.8 * z) * variety(rnd), rnd() * 6.28)
      }
    }
    for (const [x, top] of tops) {
      const b = binOf(x)
      skyline[b] = Math.max(skyline[b], top)
    }
  }
}

/** Concentric rings round the head, rippling outwards while it listens. */
function buildHalo(push) {
  const RINGS = 7
  const COUNT = 900
  for (let i = 0; i < RINGS; i++) {
    for (let k = 0; k < COUNT; k++) {
      push(0, 0, (2 * Math.PI * k) / COUNT, i / RINGS, 0, 0, KIND.halo, 1.3)
    }
  }
}

function buildDust(rnd, push, extent, bottom) {
  for (let i = 0; i < 1500; i++) {
    const y = bottom + rnd() * (1.2 - bottom)
    push((rnd() * 2 - 1) * extent, y, 0.5 + rnd(), rnd(), 1 + rnd() * 3, 0, KIND.dust, 1.0 * variety(rnd))
  }
}

/** Everything around the figure, for a view `extent` wide each side, down to `bottom`. */
export function buildLandscape(rnd, push, extent, bottom) {
  buildMountains(rnd, push, extent, bottom)
  buildHalo(push)
  buildDust(rnd, push, extent, bottom)
}
