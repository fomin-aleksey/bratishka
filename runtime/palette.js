// The robot's colors. Every color of the scene comes from here: pick another
// palette below and the head, the body, the mountains and the glow follow.
//
// dim: faint lines; main: the body's own color; pale: highlights and rims;
// accent: veins, rivers, sparks; glow and hot: the face's inner light;
// sky: the background at the top of the window.

export const PALETTES = {
  /** White with red: the honeycomb body the person picked. */
  ivory: {
    dim: [0.3, 0.3, 0.34],
    main: [0.88, 0.9, 0.96],
    pale: [1.0, 1.0, 1.0],
    accent: [1.0, 0.22, 0.28],
    glow: [1.0, 0.2, 0.25],
    hot: [1.0, 0.86, 0.86],
    sky: [0.012, 0.012, 0.016],
  },
  /** Cyan with gold, after the Apex humanoid. */
  classic: {
    dim: [0.09, 0.4, 1.0],
    main: [0.3, 0.8, 1.0],
    pale: [0.8, 0.94, 1.0],
    accent: [1.0, 0.66, 0.22],
    glow: [1.0, 0.4, 0.07],
    hot: [1.0, 0.9, 0.62],
    sky: [0.01, 0.022, 0.052],
  },
}

export const PALETTE = PALETTES.ivory

/** A color as GLSL, `vec3(r, g, b)`, scaled by `k`. */
export const glsl = (rgb, k = 1) => `vec3(${rgb.map(c => (c * k).toFixed(3)).join(', ')})`
