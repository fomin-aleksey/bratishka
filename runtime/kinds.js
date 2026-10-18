// What every part of the scene shares: the particle kinds the shader knows,
// where the head and the sternum sit, how a particle is laid out, the
// camera's height and a few small helpers.

export const KIND = {
  ring: 0,
  neck: 2,
  torso: 4,
  aura: 5,
  halo: 7,
  dust: 9,
  spark: 12,
  orbit: 13,
}

export const HEAD = [0, 0.31]
/** Where the heart beats, a little to the robot's left, and where the orb of the intro shines. */
export const HEART = [0.05, -0.28]
/** The world height the camera looks at: the bust fills the window down to the chest. */
export const CAM_Y = 0.2
/** Where the bust ends: the body fades out below the middle of the chest. */
export const BUST_END = -0.4
/** Floats per particle: pos(2) p(4) q(4). */
export const FLOATS = 10

/** A seeded random number generator: the same scene on every load. */
export function random(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Mostly small, some medium, a few large: the sizes of a living point cloud.
 * `large` is the share of large points.
 */
export const variety = (rnd, large = 0.04) => {
  const r = rnd()
  if (r < 0.74) return 0.7 + 0.4 * rnd()
  if (r < 1 - large) return 1.35 + 0.6 * rnd()
  return 2.3 + 1.7 * rnd()
}

/**
 * When a figure particle lands in the intro, 0 first to 1 last: the stream
 * sweeps from the bottom left up over the head and down the right side, with
 * some scatter, and `delay` holds a part back.
 */
export const arrival = (x, y, rnd, delay = 0) => {
  const theta = Math.atan2(y - 0.05, x)
  const turn = 2 * Math.PI
  const sweep = ((((-0.75 * Math.PI - theta) % turn) + turn) % turn) / turn
  return Math.min(1, 0.68 * sweep + 0.16 * rnd() + delay)
}
