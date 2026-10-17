// The whole scene as GPU data: one array of particles.

import { random } from './kinds.js'
import { buildFigure } from './figure.js'
import { buildOrbits } from './head.js'
import { buildLandscape } from './landscape.js'

/** Particles (FLOATS each) for a view `extent` wide each side of the figure, down to `bottom`. */
export function buildScene({ extent, bottom }) {
  const rnd = random(20251014)
  const data = []
  const push = (x, y, p0, p1, p2, p3, kind, size, w = 0) => {
    data.push(x, y, p0, p1, p2, p3, kind, size, rnd(), w)
  }
  buildFigure(rnd, push, bottom)
  buildLandscape(rnd, push, extent, bottom)
  // Last, so the landscape keeps the random numbers it always had.
  buildOrbits(rnd, push)
  return new Float32Array(data)
}
