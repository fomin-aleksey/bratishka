// The stage around the figure: concentric rings round the head that ripple
// while the robot listens, and a little dust. Behind them the backdrop of
// glyphs (rain.js), drawn in the compose pass. The stage does not listen to
// the voice.

import { KIND, variety } from './kinds.js'

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
  buildHalo(push)
  buildDust(rnd, push, extent, bottom)
}
