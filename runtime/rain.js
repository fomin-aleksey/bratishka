// The backdrop: a floor of glyphs running off to a horizon at the robot's
// neck and digital rain above it in three layers of depth, the far one small
// and dim, the near one big and out of focus. It is drawn in the compose
// pass, a glyph per cell of the screen, behind the figure and never through
// it, and opened by the intro's shock. It lives on its own clock: it never
// listens to the voice.
//
// The glyphs come from an atlas of half-width katakana painted once on a
// canvas, mirrored as they fall.

const COLS = 8
const ROWS = 6
const CELL = 64
const GLYPHS = [...'ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ']

/** The atlas: white glyphs on black, COLS by ROWS cells of CELL pixels. */
export function paintGlyphs() {
  const canvas = document.createElement('canvas')
  canvas.width = COLS * CELL
  canvas.height = ROWS * CELL
  const g = canvas.getContext('2d')
  g.fillStyle = '#000'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.fillStyle = '#fff'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `${CELL * 0.74}px "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Osaka", sans-serif`
  GLYPHS.forEach((char, i) => {
    g.fillText(char, (i % COLS) * CELL + CELL / 2, Math.floor(i / COLS) * CELL + CELL / 2 + 2)
  })
  return canvas
}

const f = x => x.toFixed(4)

/**
 * The backdrop's GLSL for the compose shader, after its uniforms and
 * HEAD_GLSL (it needs u_time, u_view, u_shift, u_zoom and CAM_Y): it defines
 * `vec3 backdrop(vec2 px)` for the pixel px. Colors come from the palette,
 * as GLSL vec3s.
 */
export const backdropGlsl = ({ main, pale, accent, glow }) => `
uniform sampler2D u_glyphs;
uniform sampler2D u_shape;
uniform vec2 u_res;

float h11(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

/** The ink of glyph \`index\` at \`uv\` in its cell (y up), mirrored; \`lod\` blurs it. */
float glyph(float index, vec2 uv, float lod) {
  uv = clamp(uv, 0.0, 1.0);
  uv.x = 1.0 - uv.x;
  vec2 cell = vec2(mod(index, ${f(COLS)}), floor(index / ${f(COLS)}));
  vec2 at = (cell + vec2(uv.x, 1.0 - uv.y)) / vec2(${f(COLS)}, ${f(ROWS)});
  return textureLod(u_glyphs, at, lod).r;
}

/** Which glyph a cell shows now: each changes on a clock of its own. */
float glyphNow(vec2 cell, float rate, float seed) {
  float turn = floor(u_time * rate * (0.3 + 1.4 * h21(cell + seed)) + h21(cell * 1.7 + seed) * 10.0);
  return floor(h21(cell + turn * 0.1371 + seed * 3.1) * ${f(GLYPHS.length)});
}

/**
 * Drops falling down the columns of cells \`size\` pixels big, a cell at a
 * time: each column's drops at a speed (cells a second) and a tail length
 * of their own, \`density\` of the columns raining at all. Returns how lit
 * the cell at px is (1 at a drop's head, fading down its tail) and whether
 * it is the head itself.
 */
vec2 rain(vec2 px, vec2 size, float speed, float tail, float density, float seed) {
  vec2 cell = floor(px / size);
  float rows = ceil(u_res.y / size.y);
  float fromTop = rows - 1.0 - cell.y;
  float lit = 0.0;
  float head = 0.0;
  for (int k = 0; k < 2; k++) {
    float id = cell.x * 13.7 + float(k) * 71.3 + seed;
    if (h11(id) > density) continue;
    float v = speed * (0.55 + 0.9 * h11(id + 3.1));
    float len = tail * (0.5 + h11(id + 5.3));
    float span = rows + len + 6.0;
    float at = floor(mod(u_time * v + h11(id + 9.7) * span, span));
    float d = at - fromTop;
    if (d < 0.0 || d > len) continue;
    lit = max(lit, pow(1.0 - d / len, 1.5));
    head = max(head, step(d, 0.5));
  }
  return vec2(lit, head);
}

/** A layer of rain in cells \`cs\` pixels high, \`tail\` and \`head\` its colors, its glyphs blurred by \`lod\`. */
vec3 rainLayer(vec2 px, float cs, float speed, float density, float seed, float lod, vec3 tail, vec3 head) {
  vec2 size = vec2(cs * 0.82, cs);
  vec2 r = rain(px, size, speed, 16.0, density, seed);
  if (r.x <= 0.0) return vec3(0.0);
  vec2 cell = floor(px / size);
  float ink = glyph(glyphNow(cell, 1.5, seed), fract(px / size), lod);
  return mix(tail * r.x, head, r.y) * ink;
}

/**
 * Where a pixel below \`horizon\` (in pixels) lies on a floor of glyph cells
 * drifting towards the camera at \`speed\`: its cell coordinates, how far
 * below the horizon it is (in screen heights) and how deep.
 */
vec4 floorAt(vec2 px, float horizon, float speed) {
  float t = (horizon - px.y) / u_res.y;
  float depth = 0.09 / max(t, 0.002);
  return vec4((px.x - u_res.x * 0.5) / u_res.y * depth * 11.0, depth * 11.0 - u_time * speed, t, depth);
}

/**
 * The ink of the floor's glyph at \`f\` (from floorAt), \`on\` of the cells
 * lit: blurred with distance, lost in the dark at the horizon and fading
 * out at the bottom of the screen before the near glyphs grow huge.
 */
float floorInk(vec4 f, float on, float seed) {
  vec2 cell = floor(f.xy);
  if (h21(cell + seed) > on) return 0.0;
  float lod = clamp(log2(f.w * 1.6), 0.0, 4.0);
  float ink = glyph(glyphNow(cell, 0.7, seed), fract(f.xy), lod);
  float fog = smoothstep(0.0, 0.2, f.z) * (1.0 - smoothstep(0.3, 0.48, f.z));
  float flick = 0.55 + 0.45 * sin(u_time * (1.0 + 3.0 * h21(cell + 4.0)) + h21(cell) * 30.0);
  return ink * fog * flick;
}

/** The figure's half-width at world height y, 0 where there is none. */
float figureWidth(float y) {
  if (y > ${f(0.75)}) return 0.0;
  return texture(u_shape, vec2(clamp((y + 2.4) / 3.15, 0.0, 1.0), 0.5)).r;
}

/** Where a world point is on the screen, in pixels. */
vec2 toPixels(vec2 world) {
  vec2 ndc = ((world - vec2(0.0, CAM_Y)) * u_zoom + vec2(u_shift, 0.0)) / u_view;
  return (ndc * 0.5 + 0.5) * u_res;
}

/** The floor below the horizon, the rain in three layers above it, both in the robot's colors. */
vec3 backdrop(vec2 px) {
  float cs = u_res.y / 46.0;
  float horizon = toPixels(vec2(0.0, 0.12)).y;
  vec3 tail = mix(${accent}, ${glow}, 0.4) * 0.95;
  if (px.y < horizon) {
    vec4 f = floorAt(px, horizon, 0.8);
    float red = step(0.9, h21(floor(f.xy) + 2.0));
    return mix(${main} * 0.7, tail * 1.2, red) * floorInk(f, 0.45, 9.0);
  }
  vec3 c = rainLayer(px, cs * 0.55, 4.0, 0.7, 51.0, 0.0, tail, ${pale}) * 0.5
    + rainLayer(px + vec2(cs * 0.3, 0.0), cs, 7.0, 0.42, 52.0, 0.0, tail, ${pale})
    + rainLayer(px + vec2(cs * 0.7, 0.0), cs * 2.1, 11.0, 0.2, 53.0, 2.2, tail, ${pale}) * 0.85;
  return c * smoothstep(0.0, cs * 2.0, px.y - horizon);
}`
