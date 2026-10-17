// The figure: an egg of a head drawn in horizontal
// slices bent over a face's relief inside a bright rim; the shoulders and
// chest of a strong man under a honeycomb of hexagonal cells inside a faceted
// neon outline; a double helix of veins down the neck to the sternum; a
// tuft of sparks off the crown and a few more drifting off the shoulders.
//
// Every figure particle carries in its last float the moment it lands in
// the intro (see arrival() in kinds.js).

import { BUST_END, HEAD, KIND, STERNUM, arrival, random, smooth, variety } from './kinds.js'

/** A smooth function through (x, y) points sorted by x: cubic Hermite, Catmull-Rom tangents. */
function curve(points) {
  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  const n = points.length
  const slope = i => {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    return (ys[b] - ys[a]) / (xs[b] - xs[a])
  }
  return x => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i]
    const t = (x - xs[i]) / h
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * slope(i) +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * slope(i + 1)
    )
  }
}

// The head, front on: half its width (in HEAD_W) at each height v, from the
// chin (v = -1) to the crown (v = 1). Broad at the temples, small ears, a
// soft jaw and a narrow chin.
const HEAD_W = 0.207
const HEAD_H = 0.3
const headWidth = curve([
  [-1.0, 0.0], [-0.99, 0.18], [-0.95, 0.28], [-0.88, 0.38], [-0.78, 0.52], [-0.58, 0.71],
  [-0.385, 0.885], [-0.27, 0.95], [-0.2, 1.01], [-0.1, 1.045], [-0.02, 1.04], [0.06, 0.995],
  [0.2, 0.995], [0.4, 0.97], [0.6, 0.91], [0.8, 0.75], [0.9, 0.61], [0.95, 0.46], [0.985, 0.28],
  [1.0, 0.0],
])

const g2 = (a, b) => Math.exp(-(a * a + b * b))

/** How far the face stands out at (u, v), in head widths: nose, brows, eyes, lips, chin. */
const relief = (u, v) => {
  const au = Math.abs(u)
  return (
    0.18 * g2(u / 0.1, (v + 0.1) / 0.25) +
    0.2 * g2(u / 0.14, (v + 0.32) / 0.08) +
    0.1 * g2((au - 0.35) / 0.25, (v - 0.1) / 0.06) -
    0.14 * g2((au - 0.36) / 0.17, v / 0.09) +
    0.08 * g2((au - 0.55) / 0.18, (v + 0.12) / 0.12) +
    0.1 * g2(u / 0.28, (v + 0.55) / 0.07) -
    0.06 * g2(u / 0.25, (v + 0.56) / 0.018) +
    0.1 * g2(u / 0.25, (v + 0.82) / 0.09)
  )
}

/**
 * The tilt of a horizontal slice at height v, as a camera at nose height
 * sees it: slices above bow up, slices below bow down.
 */
const tilt = v => Math.max(-0.2, Math.min(0.14, 0.26 * (v + 0.1)))

/** A polyline by the share of its length: `at(t)` for t in [0, 1], and its `total` length. */
function measured(poly) {
  const lengths = [0]
  for (let i = 1; i < poly.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]))
  }
  const total = lengths[lengths.length - 1] || 1
  let i = 1
  const at = t => {
    const want = t * total
    // Most calls walk forwards: start from the last segment found.
    if (lengths[i - 1] > want) i = 1
    while (i < lengths.length - 1 && lengths[i] < want) i++
    const f = (want - lengths[i - 1]) / (lengths[i] - lengths[i - 1] || 1)
    return [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * f, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * f]
  }
  return { at, total }
}

// The body, right side, from the neck behind the jaw down past the screen's
// edge, in straight segments with hard corners: a thick neck, the trapezius
// in two facets, a chamfered shoulder, the arm falling straight, then in.
const BODY_TOP = 0.12
const OUTLINE = [
  [0.15, 0.12], [0.15, 0.04], [0.3, -0.04], [0.502, -0.12], [0.599, -0.22], [0.599, -0.4], [0.546, -0.55], [0.528, -2.4],
]

/** Straight segments through the points, in short even steps: hard corners kept. */
const densify = points => {
  const out = []
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.002))
    for (let k = 0; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n])
  }
  out.push(points[points.length - 1])
  return out
}

const SILHOUETTE = densify(OUTLINE)

/** The body's half-width at height y: a table read off the silhouette. */
const bodyWidth = (() => {
  const Y0 = -2.4
  const STEP = 0.002
  const table = new Float32Array(Math.ceil((BODY_TOP - Y0) / STEP) + 2)
  for (let i = 1; i < SILHOUETTE.length; i++) {
    const [x0, y0] = SILHOUETTE[i - 1]
    const [x1, y1] = SILHOUETTE[i]
    const lo = Math.ceil((Math.min(y0, y1) - Y0) / STEP)
    const hi = Math.floor((Math.max(y0, y1) - Y0) / STEP)
    for (let k = Math.max(0, lo); k <= Math.min(table.length - 1, hi); k++) {
      const y = Y0 + k * STEP
      const x = y1 === y0 ? Math.max(x0, x1) : x0 + ((x1 - x0) * (y - y0)) / (y1 - y0)
      table[k] = Math.max(table[k], x)
    }
  }
  return y => {
    const f = Math.max(0, Math.min(table.length - 1.001, (y - Y0) / STEP))
    const k = Math.floor(f)
    return table[k] + (table[k + 1] - table[k]) * (f - k)
  }
})()

const insideHead = (x, y) => {
  const v = (y - HEAD[1]) / HEAD_H
  return v > -1.04 && v < 1.06 && Math.abs(x) < headWidth(Math.max(-1, Math.min(1, v))) * HEAD_W * 1.04 + 0.006
}

const insideBody = (x, y) => y < BODY_TOP && Math.abs(x) < bodyWidth(y)

export const insideFigure = (x, y) => insideHead(x, y) || insideBody(x, y)

/**
 * The figure's half-width at height y, head or body, 0 where neither: what
 * the background hides behind. A little generous, the rim included.
 */
export const figureHalfWidth = y => {
  const v = (y - HEAD[1]) / HEAD_H
  const head = v > -1.05 && v < 1.06 ? headWidth(Math.max(-1, Math.min(1, v * 0.97))) * HEAD_W * 1.05 + 0.008 : 0
  const body = y < BODY_TOP ? bodyWidth(y) + 0.006 : 0
  return Math.max(head, body)
}

const norm = (a, b) => {
  const len = Math.hypot(a, b) || 1
  return [a / len, b / len]
}

/** The head: horizontal slices bent over the face's relief, each point knowing how far it stands out (for the head's turn). */
function buildHead(rnd, push) {
  const LINES = 34
  for (let j = 0; j < LINES; j++) {
    const v = 0.955 - (1.91 * j) / (LINES - 1)
    const half = headWidth(v) * HEAD_W * 0.975
    if (half < 0.004) continue
    const yc = HEAD[1] + v * HEAD_H
    const lean = tilt(v)
    const steps = Math.max(8, Math.round(half / 0.001))
    for (let k = 0; k <= steps; k++) {
      const u = -1 + (2 * k) / steps
      const round = Math.sqrt(Math.max(0, 1 - u * u))
      const depth = (half + 2 * HEAD_W * relief(u, v)) * round
      const x = u * half
      const y = yc + lean * depth
      const edge = smooth(0.8, 1, Math.abs(u))
      const size = (1.7 + 0.4 * edge) * variety(rnd, 0.02)
      const at = arrival(x, y, rnd, 0.12)
      push(x, y, u, v, depth, edge, KIND.ring, size, at)
      if (rnd() < 0.55) {
        push(x + (rnd() - 0.5) * 0.001, y + (rnd() - 0.5) * 0.002, u, v, depth, edge, KIND.ring, size * 0.8, at)
      }
    }
  }
}

/** The head's outline: a bright band a few points wide, even along its length. */
function buildRim(rnd, push) {
  const points = []
  for (let i = 0; i <= 3000; i++) {
    const v = 1 - (2 * i) / 3000
    points.push([headWidth(v) * HEAD_W, HEAD[1] + v * HEAD_H, v])
  }
  let carried = 0
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x, y, v] = points[i]
    carried += Math.hypot(x - x0, y - y0)
    if (carried < 0.0009) continue
    carried = 0
    const [nx, ny] = norm(x / HEAD_W, (y - HEAD[1]) / HEAD_H)
    for (const side of [-1, 1]) {
      for (let t = 0; t < 3; t++) {
        const off = (rnd() + rnd() - 1) * 0.0055
        const px = side * (x + nx * off)
        const py = y + ny * off
        push(px, py, side, v, 0, 1, KIND.ring, 1.8 * variety(rnd, 0.03), arrival(px, py, rnd))
      }
    }
  }
}

/** The throat: faint slices between the neck's muscles, bowed as seen from a little above. */
function buildNeck(rnd, push) {
  for (let y = 0.04; y > -0.08; y -= 0.011) {
    const half = Math.min(bodyWidth(y) * 0.96, 0.11)
    const steps = Math.round(half / 0.0012)
    for (let k = 0; k <= steps; k++) {
      const u = -1 + (2 * k) / steps
      const x = u * half
      const py = y - 0.12 * half * Math.sqrt(Math.max(0, 1 - u * u))
      if (insideHead(x, py) || rnd() < 0.3) continue
      push(x, py, (0.04 - y) / 0.12, u, 0, 0, KIND.neck, 1.2 * variety(rnd, 0.03), arrival(x, py, rnd, 0.1))
    }
  }
}

/**
 * Veins of light down the neck as a double helix: two strands twisting round
 * each other from under the chin to the sternum, rungs between them.
 */
function buildVeins(push) {
  // A generator of its own: the helix keeps its look whatever else draws.
  const own = random(4242)
  const TOP = 0.0
  // The strands cross every PI / 38 down the neck; the twist right under the
  // chin is left out, so the helix starts at its first crossing.
  const START = TOP - Math.PI / 38
  const along = y => (TOP - y) / (TOP - STERNUM[1])
  const dot = (x, y, branch, size) => {
    const t = along(y)
    const at = Math.min(1, 0.5 + 0.42 * t + 0.06 * own())
    push(x, y, t, branch, own(), 0, KIND.vein, size * variety(own, 0.05), at)
    push(x + (own() - 0.5) * 0.003, y + (own() - 0.5) * 0.002, t, branch, own(), 0, KIND.vein, size * 0.67, at)
  }
  const amplitude = y => 0.035 + 0.02 * along(y)
  for (let y = START; y > STERNUM[1] + 0.01; y -= 0.0022) {
    const x = amplitude(y) * Math.sin(y * 38)
    dot(x, y, 0, 1.9)
    dot(-x, y, 0, 1.9)
  }
  // Rungs, where the strands are apart; dimmer, as side branches.
  for (let y = START - 0.02; y > STERNUM[1] + 0.02; y -= 0.022) {
    const x = Math.abs(amplitude(y) * Math.sin(y * 38))
    if (x <= 0.008) continue
    for (let px = -x; px <= x; px += 0.003) dot(px, y, 1, 1.2)
  }
}

/** The body's outline: a neon band a few points wide down the silhouette, both sides. */
function buildOutline(rnd, push, bottom) {
  const line = measured(SILHOUETTE)
  const steps = Math.ceil(line.total / 0.0011)
  let [px, py] = line.at(0)
  for (let k = 1; k <= steps; k++) {
    const [x, y] = line.at(k / steps)
    const [nx, ny] = norm(py - y, x - px)
    px = x
    py = y
    if (y < Math.max(bottom - 0.05, BUST_END - 0.2) || insideHead(x, y)) continue
    for (const side of [-1, 1]) {
      for (let t = 0; t < 3; t++) {
        const off = (rnd() + rnd() - 1) * 0.005
        const sx = side * (x + nx * off)
        push(sx, y + ny * off, 0.9, 0, 1, 0, KIND.torso, 1.75 * variety(rnd, 0.03), arrival(sx, y, rnd))
      }
    }
  }
}

/** How far down the body is drawn: a little past where it fades out. */
const BODY_LOW = BUST_END - 0.18
/** How much a raised point of the body drops on the screen, as a camera above the chest sees it. */
const TILT = 0.35

// The muscles follow the outline: how wide the shoulders are, and how high
// their corner sits (where the outline first reaches 90% of that width).
const SHOULDER = (() => {
  let width = 0
  for (let y = -0.06; y > -0.45; y -= 0.005) width = Math.max(width, bodyWidth(y))
  let corner = -0.2
  for (let y = 0.05; y > -0.45; y -= 0.005) {
    if (bodyWidth(y) >= 0.9 * width) {
      corner = y
      break
    }
  }
  return { k: width / 0.67, corner }
})()

/** How far the body stands out at (x, y): a rounded trunk, pecs, delts, traps, neck, collarbones, sternum. */
const bodyRelief = (x, y) => {
  const ax = Math.abs(x)
  const w = bodyWidth(y)
  if (w <= 0) return 0
  const u = Math.min(1, ax / w)
  const { k, corner } = SHOULDER
  return (
    0.16 * Math.sqrt(Math.max(0, 1 - u * u)) +
    0.09 * g2((ax - 0.22 * (0.5 + 0.5 * k)) / 0.17, (y + 0.36) / 0.14) +
    0.08 * g2((ax - 0.56 * k) / 0.11, (y - corner + 0.08) / 0.13) +
    0.05 * g2((ax - 0.3 * k) / 0.13, (y + 0.07) / 0.05) +
    0.03 * g2((ax - 0.12) / 0.03, (y + 0.05) / 0.1) +
    0.015 * g2((y + 0.168 + 0.02 * (ax - 0.2)) / 0.012, 0) * smooth(0.02, 0.06, ax) * (1 - smooth(0.38, 0.45, ax)) -
    0.03 * g2(ax / 0.025, 0) * smooth(-0.15, -0.25, y)
  )
}

const insideTorso = (x, y) => y < BODY_TOP && y > BODY_LOW && Math.abs(x) < bodyWidth(y) - 0.004 && !insideHead(x, y)

const LIGHT = norm(0.55, 0.83)

/** How much light a point of the body catches from above and in front, 0 to 1, with some contrast. */
const bodyLight = (x, y) => {
  const e = 0.004
  const dx = (bodyRelief(x + e, y) - bodyRelief(x - e, y)) / (2 * e)
  const dy = (bodyRelief(x, y + e) - bodyRelief(x, y - e)) / (2 * e)
  const n = [-dx * 1.6, -dy * 1.6, 1]
  return smooth(0.45, 1.0, (n[1] * LIGHT[0] + n[2] * LIGHT[1]) / Math.hypot(...n))
}

/**
 * The body: a honeycomb of hexagonal cells laid over a strong man's
 * shoulders and chest, each as bright as the muscle under it catches the
 * light, a few glowing; a cluster of sparks at the sternum.
 */
function buildHoneycomb(rnd, push) {
  // A generator of its own: the same cells glow whatever else draws.
  const own = random(66)
  const phase = rnd()
  const R = 0.027
  const W = Math.sqrt(3) * R
  const H = 1.5 * R
  const dot = (x, y, { shade, t = 0, glowing = false, size, mirror }) => {
    const py = y - TILT * bodyRelief(x, y)
    for (const side of mirror ? [1, -1] : [1]) {
      push(side * x, py, shade, t, glowing ? 3 : 0, phase, KIND.torso, size * variety(rnd, 0.03), arrival(side * x, py, rnd, 0.1))
    }
  }
  for (let j = 0; 0.08 - j * H > BODY_LOW - R; j++) {
    const cy = 0.08 - j * H
    const shift = j % 2 ? W / 2 : 0
    for (let i = 0; shift + i * W < 0.75; i++) {
      const cx = shift + i * W
      if (!insideTorso(cx, cy)) continue
      // The cell on the midline is its own mirror image.
      const mirror = cx > 0.001
      const light = bodyLight(cx, cy)
      const glowing = own() < 0.14
      for (let k = 0; k < 6; k++) {
        const a0 = Math.PI / 6 + (k * Math.PI) / 3
        const a1 = a0 + Math.PI / 3
        const r = R * 0.9
        for (let s = 0; s < 22; s++) {
          const f = s / 22
          const x = cx + r * (Math.cos(a0) + (Math.cos(a1) - Math.cos(a0)) * f)
          const y = cy + r * (Math.sin(a0) + (Math.sin(a1) - Math.sin(a0)) * f)
          if (!insideTorso(x, y) || (!mirror && x < 0)) continue
          dot(x, y, { shade: 0.2 + 0.8 * light, t: k / 6, glowing, size: 1.0, mirror })
        }
      }
      if (!glowing) continue
      for (let k = 0; k < 40; k++) {
        const a = own() * Math.PI * 2
        const r = Math.sqrt(own()) * R * 0.75
        const x = cx + Math.cos(a) * r
        const y = cy + Math.sin(a) * r
        if (insideTorso(x, y)) dot(x, y, { shade: 0.9, size: 1.2, mirror })
      }
    }
  }
  for (let i = 0; i < 380; i++) {
    const r = Math.abs(rnd() + rnd() - 1) * 0.04
    const a = rnd() * Math.PI * 2
    const x = STERNUM[0] + Math.cos(a) * r * 0.8
    const y = STERNUM[1] + Math.sin(a) * r
    push(x, y, 0, 0, 2, 0, KIND.torso, 1.5 * variety(rnd, 0.1), arrival(x, y, rnd, 0.25))
  }
}

/** Sparks off the head: a tuft rising from the crown like a flame, a few off the temples. */
function buildAura(rnd, push) {
  for (let i = 0; i < 9000; i++) {
    const v = 1 - Math.pow(rnd(), 1.6) * 1.35
    const side = rnd() < 0.5 ? -1 : 1
    const half = headWidth(Math.max(-1, Math.min(1, v))) * HEAD_W
    const x = side * half * (0.97 + rnd() * 0.05)
    const y = HEAD[1] + v * HEAD_H + (v > 0.93 ? rnd() * 0.008 : 0)
    const crown = smooth(0.55, 1, v)
    const reach = (0.012 + Math.pow(rnd(), 2.2) * 0.1) * (0.45 + 1.1 * crown)
    push(x, y, side, 0.4 + rnd() * 1.2, rnd(), reach, KIND.aura, 1.0 + rnd() * 1.3, arrival(x, y, rnd, 0.22))
  }
}

/** Sparks drifting off the neck and shoulders, along the outline's outward normal. */
function buildSparks(rnd, push) {
  for (let i = 0; i < 1600; i++) {
    const y = -0.03 - Math.pow(rnd(), 0.8) * 0.5
    const step = 0.004
    const slope = (bodyWidth(y - step) - bodyWidth(y + step)) / (2 * step)
    const [nx, ny] = norm(1, slope)
    const side = rnd() < 0.5 ? -1 : 1
    const lift = rnd() * 0.01
    const x = side * (bodyWidth(y) + nx * lift)
    const py = y + ny * lift
    push(x, py, side * nx, ny, 0.3 + rnd(), 0.015 + Math.pow(rnd(), 2) * 0.07, KIND.spark, 1.0 + rnd() * 1.2, arrival(x, py, rnd, 0.22))
  }
}

/** The whole figure, pushed particle by particle, its body down to `bottom`. */
export function buildFigure(rnd, push, bottom) {
  buildHead(rnd, push)
  buildRim(rnd, push)
  buildNeck(rnd, push)
  buildVeins(push)
  buildOutline(rnd, push, bottom)
  buildHoneycomb(rnd, push)
  buildAura(rnd, push)
  buildSparks(rnd, push)
}
