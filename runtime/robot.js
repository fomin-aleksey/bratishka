// The robot: a particle bust drawn with WebGL2, lit by the voice.
//
// World space: the figure's own units, the head at y = 0.31, the sternum at
// y = -0.4, where the bust fades out. The camera looks at y = CAM_Y and zooms
// so the bust fills the window down to the chest, as wide as the room beside the text panel
// allows. Every particle is one point; the vertex shader moves and colors it
// by its kind, the voice's loudness, the state
// (listening, thinking, speaking) and the intro. Particles are drawn
// additively into a float buffer, blurred twice for the glow and composed
// over a procedural background. The head's pose and the sparks it thinks
// with come from head.js.

import { BUST_END, CAM_Y, FLOATS, HEAD, HEART, KIND } from './kinds.js'
import { figureHalfWidth } from './figure.js'
import { pulseAt } from './alive.js'
import { HEAD_GLSL, HEAD_KINDS, headFrame } from './head.js'
import { PALETTE as P, glsl } from './palette.js'
import { buildScene } from './scene.js'

/** The closest the camera comes, and the farthest it backs off for a narrow window. */
const MAX_ZOOM = 1.45
const MIN_ZOOM = 0.6
/** How wide a view, in world units, the figure wants to itself. */
const FIT_WIDTH = 1.5
/** How long the shock that opens the mountains runs, in shares of the intro. */
const REVEAL = 0.35
const REVEAL_REACH = 4

const vec2 = ([x, y]) => `vec2(${x.toFixed(3)}, ${y.toFixed(3)})`
const COMMON = `
const vec2 HEAD = ${vec2(HEAD)};
const vec2 CORE = vec2(0.0, 0.22);
const vec2 HEART = ${vec2(HEART)};
// The orb the figure streams out of in the intro: the heart.
const vec2 ORB = HEART;
const float CAM_Y = ${CAM_Y.toFixed(3)};
const float BUST_END = ${BUST_END.toFixed(3)};`

// ------------------------------------------------------------------ shaders

// The figure stands in front: background fragments inside its silhouette
// (half-width per height, baked into u_shape) are not drawn.
const SHAPE_Y0 = -2.4
const SHAPE_Y1 = 0.75
const SHAPE_SIZE = 2048
const BEHIND_FIGURE = `
uniform sampler2D u_shape;
uniform vec2 u_res;
uniform vec2 u_view;
uniform float u_shift;
uniform float u_zoom;
bool behindFigure() {
  vec2 world = (gl_FragCoord.xy / u_res * 2.0 - 1.0) * u_view;
  vec2 f = (world - vec2(u_shift, 0.0)) / u_zoom + vec2(0.0, CAM_Y);
  if (f.y > ${SHAPE_Y1.toFixed(3)}) return false;
  float t = clamp((f.y - (${SHAPE_Y0.toFixed(3)})) / ${(SHAPE_Y1 - SHAPE_Y0).toFixed(3)}, 0.0, 1.0);
  return abs(f.x) < texture(u_shape, vec2(t, 0.5)).r;
}`

const PARTICLE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_p;
layout(location = 2) in vec4 a_q;

uniform vec2 u_view;
uniform float u_shift;
uniform float u_zoom;
uniform float u_time;
uniform float u_flow;
uniform float u_level;
uniform float u_speak;
uniform float u_think;
uniform float u_listen;
uniform float u_build;
uniform float u_reveal;
uniform float u_px;
uniform float u_onset;
uniform float u_offset;
uniform float u_mic;
uniform float u_ear;
// The heart: where its glow is now, how full it is (0 to 1), seconds since it beat.
uniform vec4 u_heart;

out vec3 v_color;
out float v_alpha;
out float v_back;
${COMMON}
${HEAD_GLSL}
const vec3 DIM = ${glsl(P.dim)};
const vec3 MAIN = ${glsl(P.main)};
const vec3 PALE = ${glsl(P.pale)};
const vec3 ACCENT = ${glsl(P.accent)};
const vec3 GLOW = ${glsl(P.glow)};
const vec3 HOT = ${glsl(P.hot)};

float hash(float n) { return fract(sin(n) * 43758.5453); }

/**
 * How hot the face's inner light is at p: the core's fire, dimmer while it
 * thinks, when the sparks it splits into light the slices round them.
 */
float heat(vec2 p) {
  float h = clamp(1.0 - length((p - coreNow()) / vec2(0.2, 0.19)), 0.0, 1.0) * (1.0 - 0.6 * u_think);
  if (u_think > 0.002) {
    for (int i = 0; i < 4; i++) {
      vec3 o = u_orbits[i];
      h = max(h, clamp(1.0 - length(p - o.xy) / 0.07, 0.0, 1.0) * (0.55 + 0.45 * o.z) * u_think);
    }
  }
  return h;
}

/**
 * How a range's point drifts above its place, on its own clock whatever the
 * voice does: a slow swell rolling outwards across the ranges and a faint
 * shimmer of the point's own.
 */
float drift(float x, float seed, float near) {
  float swell = sin(abs(x) * 3.0 + near * 4.0 - u_time * 0.45) * (0.003 + 0.004 * near);
  float shimmer = 0.0012 * sin(u_time * (1.0 + 2.0 * hash(seed * 7.9)) + seed * 40.0);
  return swell + shimmer;
}

/** A slow band of light sweeping outwards over the ranges, 0 to 1. */
float glint(float x, float near) {
  return pow(0.5 + 0.5 * sin(abs(x) * 2.2 + near * 1.5 - u_time * 0.35), 6.0);
}

/**
 * A point of the neck or the body, turned with the shoulders and, up the
 * neck, more and more with the head; widened and lifted by the breath and
 * tipped by the shoulders' roll. How far in front it stands is guessed from
 * where it is: the neck a column, the chest a flattened barrel.
 */
vec2 moveBody(vec2 p) {
  float up = smoothstep(-0.2, 0.06, p.y);
  float wide = mix(0.6, 0.13, up);
  float depth = mix(0.24, 0.13, up) * sqrt(max(0.0, 1.0 - (p.x / wide) * (p.x / wide)));
  float yaw = mix(u_sway.z, u_head.x * 0.55, smoothstep(-0.1, 0.1, p.y));
  p.x = p.x * cos(yaw) + depth * sin(yaw);
  float breath = u_head.w;
  p = vec2(0.0, -0.35) + (p - vec2(0.0, -0.35)) * (1.0 + 0.01 * breath);
  // The shoulders rise as it breathes in.
  float shoulder = smoothstep(0.15, 0.45, abs(p.x)) * smoothstep(-0.5, -0.2, p.y) * (1.0 - smoothstep(-0.12, 0.05, p.y));
  p.y += 0.007 * breath * shoulder;
  float r = u_sway.w * (1.0 - up);
  vec2 d = p - vec2(0.0, -0.3);
  return vec2(0.0, -0.3) + vec2(d.x * cos(r) - d.y * sin(r), d.x * sin(r) + d.y * cos(r));
}

void main() {
  int kind = int(a_q.x + 0.5);
  float size = a_q.y;
  float seed = a_q.z;
  vec2 pos = a_pos;
  vec3 col = DIM;
  float alpha = 1.0;
  float lv = u_level * u_speak;
  // How full the chest is: 0 to 1, up to 2 in a sigh.
  float breathe = u_head.w;
  float pulse = 0.5 + 0.5 * sin(u_time * 3.4);

  if (kind == 0) {
    // Head: slices over the face's relief, and the rim. The face glows from
    // within, ripples and drops its jaw with the voice; the temples tremble
    // with the person's voice while it listens; the whole head turns. A
    // slice point keeps its slice's radius in a_p.w; the rim's points a 1.
    float u = a_p.x;
    float v = a_p.y;
    float outline = step(0.5, a_p.w);
    float face = (1.0 - smoothstep(0.55, 0.95, abs(u))) * smoothstep(-0.97, -0.62, v) * (1.0 - smoothstep(0.25, 0.6, v));
    float ripple = sin(u * 7.0 + u_flow * 3.2 + v * 23.0) + 0.5 * sin(u * 17.0 - u_flow * 2.1 + v * 9.0);
    pos.y += ripple * face * (0.0015 + 0.009 * lv);
    pos.y -= smoothstep(-0.5, -0.88, v) * lv * 0.016;
    float temple = smoothstep(0.55, 0.95, abs(u)) * (1.0 - smoothstep(0.3, 0.65, abs(v - 0.12))) * u_mic;
    pos.x += sign(u) * temple * 0.007 * (0.4 + 0.6 * sin(u_time * 37.0 + v * 45.0 + seed * 25.0));
    pos = HEAD + (pos - HEAD) * (1.0 + 0.006 * (breathe - 0.5));
    vec4 posed = poseHeadPoint(pos, a_p.z, clamp(0.26 * (v + 0.1), -0.2, 0.14), outline);
    pos = posed.xy;
    // Bright where the slice runs out at the head's edge, wherever that is now.
    float across = sqrt(1.0 - pow(clamp(posed.w / max(a_p.w, 0.001), 0.0, 1.0), 2.0));
    float edge = mix(smoothstep(0.8, 1.0, across), 1.0, outline);
    // Round the back it is hidden; brought nearer, a little bigger and brighter.
    float shown = mix(smoothstep(-0.012, 0.0, posed.w), 1.0, outline);
    float nearer = posed.z - a_p.z;
    float h = heat(pos);
    float rim = smoothstep(0.9, 1.0, edge);
    col = mix(DIM, MAIN, 0.35 + 0.65 * edge);
    col = mix(col, PALE, rim * 0.15);
    float warm = smoothstep(0.0, 0.35, h) * (0.85 + 0.15 * clamp(lv * 2.0, 0.0, 1.0));
    col = mix(col, mix(GLOW, ACCENT, 0.25 + 0.5 * h), warm * (1.0 - rim));
    float hot = smoothstep(0.45, 1.0, h) * (0.45 + 1.2 * clamp(lv * 1.6, 0.0, 1.0) + 0.9 * u_think);
    col = mix(col, HOT, clamp(hot, 0.0, 1.0) * (1.0 - rim));
    col = mix(col, PALE, temple * 0.4);
    alpha = mix(0.5, 1.0, edge) * (0.85 + 0.15 * sin(u * 5.0 - u_time * 1.2 + v * 11.0));
    alpha += h * (1.15 + 1.1 * lv + 0.6 * u_think);
    alpha += rim * (0.15 + 0.5 * lv) + temple * 0.8;
    size *= 1.0 + h * (0.6 + 1.2 * lv + 0.5 * u_think);
    alpha *= shown * clamp(1.0 + 1.6 * nearer, 0.6, 1.4);
    size *= clamp(1.0 + 1.4 * nearer, 0.7, 1.3);
  } else if (kind == 2) {
    // Neck slices, faint.
    col = mix(DIM, MAIN, 0.35);
    alpha = 0.3 * (1.0 - 0.5 * a_p.x);
  } else if (kind == 4) {
    // The body.
    if (a_p.z > 0.5 && a_p.z < 1.5) {
      // The outline: a neon tube.
      col = mix(MAIN, PALE, 0.1);
      alpha = 0.95 + 0.5 * lv;
    } else {
      // Muscles: fibers dim, brighter on the belly, their borders bright; a
      // pulse of light runs along the fibers while it speaks, slowly while
      // it thinks.
      float border = step(2.5, a_p.z);
      float run = smoothstep(0.82, 1.0, 0.5 + 0.5 * sin(a_p.y * 16.0 - u_flow * 3.0 + a_p.w * 6.2832));
      col = mix(DIM, MAIN, 0.25 + 0.45 * a_p.x + 0.25 * border);
      alpha = (0.18 + 0.5 * a_p.x + 0.25 * border) * (0.85 + 0.15 * breathe) + run * (0.12 * u_think + 0.55 * lv);
      col = mix(col, ACCENT, run * lv * 0.35);
      // The heart is only light: the cells round it warm to red and flare
      // with each beat, as the face does round its core.
      float hh = clamp(1.0 - length((pos - HEART) / vec2(0.15, 0.16)), 0.0, 1.0);
      float beat = u_heart.z;
      col = mix(col, mix(GLOW, ACCENT, 0.25 + 0.5 * hh), smoothstep(0.0, 0.4, hh) * (0.75 + 0.25 * beat));
      col = mix(col, HOT, smoothstep(0.5, 1.0, hh) * (0.25 + 0.75 * beat));
      alpha += hh * (0.3 + 0.9 * beat);
      size *= 1.0 + hh * (0.25 + 0.5 * beat);
    }
  } else if (kind == 5) {
    // Sparks rising off the crown and the temples like a flame; the voice
    // throws them far, and the person's voice a little while it listens.
    vec2 n = normalize((pos - HEAD) / vec2(1.0, 1.3));
    vec2 dir = normalize(n + vec2(0.0, 0.85));
    pos = poseHeadPoint(pos, 0.0, 0.0, 1.0).xy;
    float t = fract(u_flow * a_p.y * 0.09 + a_p.z);
    float reach = a_p.w * (1.0 + 3.2 * lv + 0.9 * u_think + 1.2 * u_mic);
    pos += dir * t * reach;
    pos.x += sin(t * 11.0 + seed * 30.0 + u_time * 0.7) * 0.01 * t;
    float twinkle = 0.55 + 0.45 * sin(u_time * (4.0 + seed * 6.0) + seed * 80.0);
    col = seed > 0.95 ? ACCENT : mix(MAIN, PALE, hash(seed * 13.0));
    alpha = (1.0 - t) * (1.0 - t) * twinkle * (0.95 + 0.6 * lv);
  } else if (kind == 12) {
    // Sparks drifting off the shoulders.
    float t = fract(u_time * a_p.z * 0.12 + seed);
    float reach = a_p.w * (1.0 + 2.0 * lv);
    pos += a_p.xy * t * reach + vec2(0.0, 0.02 * t * t);
    float twinkle = 0.5 + 0.5 * sin(u_time * (3.0 + seed * 5.0) + seed * 70.0);
    col = mix(MAIN, PALE, hash(seed * 11.0));
    alpha = (1.0 - t) * twinkle * 0.7;
  } else if (kind == 6) {
    // Mountains: crests bright, slopes dim, alive on their own: they do not
    // listen to the voice.
    pos.y += a_p.y + drift(pos.x, seed, a_p.z);
    float g = a_p.w;
    float near = a_p.z;
    float shine = glint(pos.x, near);
    col = mix(DIM * 0.6, DIM, 0.5 + 0.5 * near);
    col = mix(col, MAIN, smoothstep(0.1, 0.7, g));
    col = mix(col, PALE, smoothstep(0.75, 1.0, g) * 0.8 + shine * 0.3);
    alpha = (0.38 + 0.95 * g) * (0.65 + 0.35 * near) * a_q.w * (0.8 + 0.2 * sin(u_time * 2.0 + seed * 50.0));
    alpha += shine * 0.3 * a_q.w;
  } else if (kind == 10) {
    // Rivers of light down the slopes, sparks running along them at an even pace.
    pos.y += a_p.y + drift(pos.x, seed, a_p.z);
    float run = 0.5 + 0.5 * sin(a_p.w * 9.0 - u_time * 1.2);
    float spark = smoothstep(0.85, 1.0, run);
    col = mix(ACCENT, GLOW, hash(seed * 17.0) * 0.7);
    col = mix(col, HOT, spark * 0.6);
    alpha = a_q.w * (0.85 + 0.8 * spark);
    size *= 1.2 + 0.6 * spark;
  } else if (kind == 11) {
    // Sparkles on the crests, each firing on its own slow clock.
    pos.y += a_p.y + drift(pos.x, seed, a_p.z);
    float fire = 0.5 + 0.5 * sin(u_time * (0.8 + seed * 1.6) + a_q.w);
    col = mix(MAIN, PALE, 0.5 + 0.5 * fire);
    alpha = (0.35 + 0.75 * fire) * (0.5 + 0.5 * a_p.w);
    size *= 1.0 + 0.5 * fire;
  } else if (kind == 7) {
    // Rings round the head, rippling outwards while it listens: brighter,
    // quicker and trembling while the person speaks into the microphone.
    float phase = fract(a_p.y + u_ear * 0.035);
    float r = mix(0.3, 0.68, phase);
    r *= 1.0 + u_mic * 0.035 * sin(a_p.x * 9.0 + u_time * 13.0 + a_p.y * 31.0) * sin(3.14159 * phase);
    pos = u_crown + vec2(cos(a_p.x), sin(a_p.x)) * r * vec2(1.0, 1.04);
    col = mix(DIM, PALE, 0.45 + 0.4 * u_mic);
    alpha = u_listen * (0.42 + 1.6 * u_mic) * sin(3.14159 * phase) * (0.65 + 0.35 * sin(a_p.x * 7.0 + u_time * 0.8 + a_p.y * 20.0));
${HEAD_KINDS}
  } else {
    // Dust drifting through the dark.
    pos.y = mod(pos.y + 1.8 + u_time * 0.006 * a_p.x, 3.2) - 1.8;
    float twinkle = 0.5 + 0.5 * sin(u_time * a_p.z + a_p.y * 60.0);
    col = mix(DIM, PALE, hash(seed * 7.0));
    alpha = 0.08 + 0.25 * twinkle;
  }

  // The neck and the body move with the shoulders and the breath, and the
  // top of the neck bends a little with the head's sway.
  if (kind == 2 || kind == 4 || kind == 12) {
    pos = moveBody(pos);
    pos = swayHead(pos, smoothstep(-0.14, 0.12, pos.y));
  }

  // Starting to speak, a flash runs down the figure from the crown; falling
  // silent, its light ebbs away down it, slower.
  if (kind == 0 || kind == 2 || kind == 4) {
    float flash = exp(-pow((pos.y - 0.66 + u_onset * 1.6) / 0.03, 2.0)) * (1.0 - smoothstep(0.45, 0.75, u_onset));
    float ebb = exp(-pow((pos.y - 0.66 + u_offset * 0.75) / 0.06, 2.0)) * (1.0 - smoothstep(1.0, 1.5, u_offset));
    col = mix(col, PALE, flash * 0.6);
    col = mix(col, GLOW, ebb * 0.6);
    alpha += flash * 1.0 + ebb * 0.5;
    size *= 1.0 + 0.4 * flash;
  }

  // The bust ends at the chest: the body fades out below it.
  if (kind == 2 || kind == 4 || kind == 12) alpha *= smoothstep(BUST_END - 0.16, BUST_END, pos.y);

  bool back = kind == 6 || kind == 7 || (kind >= 9 && kind <= 11);
  if (back) {
    // Hidden until the intro's shock has passed.
    alpha *= smoothstep(u_reveal, u_reveal - 0.15, length(pos - HEAD));
  } else if (kind == ${KIND.orbit}) {
    // The sparks are no part of the intro: they wait for the figure.
    alpha *= smoothstep(0.9, 1.0, u_build);
  } else if (u_build < 1.0) {
    // The intro: each figure particle flies out of the orb along a curve,
    // all turning the same way, and lands at its place in its turn.
    float p = clamp((u_build * 1.25 - a_q.w * 0.85) / 0.4, 0.0, 1.0);
    float e = p * p * (3.0 - 2.0 * p);
    vec2 d = pos - ORB;
    vec2 mid = ORB + d * 0.5 + vec2(-d.y, d.x) * (0.45 + 0.4 * hash(seed * 29.0));
    vec2 flight = mix(mix(ORB, mid, e), mix(mid, pos, e), e);
    flight += vec2(sin(seed * 91.0 + e * 9.0), cos(seed * 53.0 + e * 7.0)) * 0.025 * sin(3.14159 * e);
    float landed = smoothstep(0.85, 1.0, p);
    col = mix(mix(MAIN, PALE, hash(seed * 5.0)), col, landed);
    alpha = mix(0.6 * step(0.001, p), alpha, landed);
    pos = mix(flight, pos, landed);
    size *= mix(1.3, 1.0, landed);
  }

  vec2 world = (pos - vec2(0.0, CAM_Y)) * u_zoom + vec2(u_shift, 0.0);
  gl_Position = vec4(world / u_view, 0.0, 1.0);
  gl_PointSize = max(1.0, size * u_px * u_zoom);
  // Nothing to draw: off the screen, so it costs no pixels.
  if (alpha <= 0.0005) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
  }
  v_color = col;
  v_alpha = alpha;
  v_back = back ? 1.0 : 0.0;
}`

const PARTICLE_FS = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
in float v_back;
uniform float u_gain;
${COMMON}
${BEHIND_FIGURE}
out vec4 o;
void main() {
  if (v_back > 0.5 && behindFigure()) discard;
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.6) * v_alpha * u_gain;
  o = vec4(v_color * a, 1.0);
}`

const QUAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_threshold;
out vec4 o;
void main() {
  vec3 c = texture(u_tex, v_uv + u_texel * vec2(-0.5, -0.5)).rgb
    + texture(u_tex, v_uv + u_texel * vec2(0.5, -0.5)).rgb
    + texture(u_tex, v_uv + u_texel * vec2(-0.5, 0.5)).rgb
    + texture(u_tex, v_uv + u_texel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  c *= smoothstep(u_threshold, u_threshold + 0.25, l);
  o = vec4(c, 1.0);
}`

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
out vec4 o;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb * 0.2270270270;
  c += texture(u_tex, v_uv + u_dir * 1.3846153846).rgb * 0.3162162162;
  c += texture(u_tex, v_uv - u_dir * 1.3846153846).rgb * 0.3162162162;
  c += texture(u_tex, v_uv + u_dir * 3.2307692308).rgb * 0.0702702703;
  c += texture(u_tex, v_uv - u_dir * 3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0);
}`

const COMPOSE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloomA;
uniform sampler2D u_bloomB;
uniform vec2 u_view;
uniform float u_shift;
uniform float u_zoom;
uniform float u_time;
uniform float u_level;
uniform float u_speak;
uniform float u_think;
uniform float u_build;
uniform float u_reveal;
uniform vec4 u_heart;
out vec4 o;
${COMMON}
${HEAD_GLSL}
const float REVEAL_REACH = ${REVEAL_REACH.toFixed(1)};

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 screen = (v_uv * 2.0 - 1.0) * u_view;
  vec2 w = (screen - vec2(u_shift, 0.0)) / u_zoom + vec2(0.0, CAM_Y);
  float lv = u_level * u_speak;
  float breathe = u_head.w;
  float pulse = 0.5 + 0.5 * sin(u_time * 3.4);
  // The figure's own glow comes with the figure.
  float shown = smoothstep(0.35, 0.9, u_build);

  vec3 bg = mix(${glsl(P.sky, 0.25)}, ${glsl(P.sky)}, smoothstep(-0.8, 0.9, screen.y));
  float hd = length((w - u_crown) / vec2(0.6, 0.68));
  bg += ${glsl(P.dim, 0.14)} * exp(-hd * hd * 2.2) * (0.6 + 0.2 * breathe + 0.9 * lv) * shown;
  float cd = length((w - coreNow()) / vec2(0.19, 0.17));
  float fire = 1.0 - 0.6 * u_think;
  bg += ${glsl(P.glow)} * exp(-cd * cd * 1.6) * (0.45 + 0.8 * lv) * fire * shown;
  bg += ${glsl(P.hot, 0.9)} * exp(-cd * cd * 4.5) * (0.12 + 0.6 * lv) * fire * shown;
  // The sparks the core splits into while thinking, each in a glow of its own.
  if (u_think > 0.002) {
    for (int i = 0; i < 4; i++) {
      vec3 s = u_orbits[i];
      float sd = dot(w - s.xy, w - s.xy);
      float near = u_think * (0.35 + 0.65 * s.z) * shown;
      bg += ${glsl(P.glow)} * exp(-sd / 0.0012) * near * 0.8 + ${glsl(P.hot, 0.9)} * exp(-sd / 0.00012) * near * 0.6;
    }
  }

  // The heart: a red glow in the chest, as the core's in the face, swelling
  // with each beat of the monitor's pulse.
  float hdist = length((w - u_heart.xy) / vec2(0.14, 0.14));
  bg += ${glsl(P.glow)} * exp(-hdist * hdist * 1.6) * (0.22 + 0.45 * u_heart.z) * shown;
  bg += ${glsl(P.hot, 0.9)} * exp(-hdist * hdist * 4.5) * (0.05 + 0.3 * u_heart.z) * shown;

  // The orb the figure streams out of.
  float orb = smoothstep(0.0, 0.06, u_build) * (1.0 - smoothstep(0.92, 1.12, u_build));
  float od = length(w - ORB);
  bg += (${glsl(P.pale)} * exp(-od * od / 0.0005) * 2.2 + ${glsl(P.dim)} * exp(-od * od / 0.008) * 0.9) * orb;

  // The shock that opens the mountains: a bright front, a flash behind it.
  if (u_reveal > 0.0 && u_reveal < REVEAL_REACH) {
    float sd = length(w - HEAD);
    float fade = 1.0 - u_reveal / REVEAL_REACH;
    bg += ${glsl(P.main, 0.8)} * exp(-pow((sd - u_reveal) / 0.025, 2.0)) * fade * 1.2;
    bg += ${glsl(P.dim, 0.2)} * step(sd, u_reveal) * fade * 0.6;
  }

  vec3 scene = texture(u_scene, v_uv).rgb;
  vec3 bloom = texture(u_bloomA, v_uv).rgb * 1.0 + texture(u_bloomB, v_uv).rgb * 1.25;
  vec3 c = bg + scene + bloom;
  c = vec3(1.0) - exp(-c * 1.15);

  float vig = smoothstep(1.55, 0.35, length((v_uv - 0.5) * vec2(u_view.x / u_view.y, 1.0) * 1.25));
  c *= mix(0.55, 1.0, vig);
  c += (hash(v_uv * 1000.0 + fract(u_time) * 31.0) - 0.5) * 0.012;
  o = vec4(pow(max(c, 0.0), vec3(0.95)), 1.0);
}`

// ------------------------------------------------------------------ GL plumbing

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader did not compile')
  }
  return shader
}

function program(gl, vs, fs) {
  const p = gl.createProgram()
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || 'program did not link')
  }
  const uniforms = {}
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i)
    uniforms[info.name] = gl.getUniformLocation(p, info.name)
  }
  return { p, u: uniforms }
}

function target(gl, width, height, internal, format, type) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  return { tex, fbo, width, height }
}

/** How close the camera comes for this much free room, in screen half-heights. */
const zoomFor = freeWorld => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, freeWorld / FIT_WIDTH))

/** How far the shock has spread at this point of the intro: 0 before, past the screen after. */
const revealAt = build => (build < 1 ? 0 : build >= 1 + REVEAL ? 99 : ((build - 1) / REVEAL) * REVEAL_REACH)

// ------------------------------------------------------------------ the robot

/**
 * Draws the robot into `canvas`. `frame(state)` renders one frame:
 * { time, flow, level, speak, think, listen, build, centerPx, freePx } and
 * the head's { head, sway, onset, offset, mic, ear } (see alive.js) and
 * how long ago the heart beat, { sinceBeat }.
 * `build` runs from 0 to 1 over the intro and stays past 1 after it.
 */
export function createRobot(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' })
  if (!gl) throw new Error('WebGL2 недоступен')
  const floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'))
  const fmt = floatTargets ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE]

  const particles = program(gl, PARTICLE_VS, PARTICLE_FS)
  const copy = program(gl, QUAD_VS, COPY_FS)
  const blur = program(gl, QUAD_VS, BLUR_FS)
  const compose = program(gl, QUAD_VS, COMPOSE_FS)

  const quad = gl.createVertexArray()
  gl.bindVertexArray(quad)
  const quadBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  const cloud = gl.createVertexArray()
  const cloudBuffer = gl.createBuffer()
  gl.bindVertexArray(cloud)
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffer)
  const stride = FLOATS * 4
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8)
  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24)
  gl.bindVertexArray(null)
  let count = 0
  let built = { extent: 0, bottom: 0 }

  const shape = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, shape)
  const widths = new Float32Array(SHAPE_SIZE)
  for (let i = 0; i < SHAPE_SIZE; i++) {
    widths[i] = figureHalfWidth(SHAPE_Y0 + ((SHAPE_Y1 - SHAPE_Y0) * (i + 0.5)) / SHAPE_SIZE)
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, SHAPE_SIZE, 1, 0, gl.RED, gl.FLOAT, widths)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  let targets = null

  const rebuild = view => {
    const points = buildScene(view)
    count = points.length / FLOATS
    gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW)
    built = view
  }

  const resize = () => {
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth || window.innerWidth
    const cssH = canvas.clientHeight || window.innerHeight
    // Keep the pixel count sane on big screens.
    const cap = Math.sqrt(9_000_000 / Math.max(1, cssW * cssH))
    const scale = Math.max(0.5, Math.min(dpr, cap))
    const w = Math.max(2, Math.round(cssW * scale))
    const h = Math.max(2, Math.round(cssH * scale))
    if (canvas.width === w && canvas.height === h && targets) return
    canvas.width = w
    canvas.height = h
    const half = [Math.max(1, w >> 1), Math.max(1, h >> 1)]
    const quarter = [Math.max(1, w >> 2), Math.max(1, h >> 2)]
    const eighth = [Math.max(1, w >> 3), Math.max(1, h >> 3)]
    targets = {
      scene: target(gl, w, h, ...fmt),
      half: target(gl, ...half, ...fmt),
      q1: target(gl, ...quarter, ...fmt),
      q2: target(gl, ...quarter, ...fmt),
      e1: target(gl, ...eighth, ...fmt),
      e2: target(gl, ...eighth, ...fmt),
    }
    // Wide and deep enough for the figure shifted aside by the text panel
    // (up to 40% of the window) and the camera backed off as frame() may.
    const aspect = w / h
    const zoomed = zoomFor(aspect * 2 * 0.6)
    const extent = (Math.max(1.2, aspect) * 1.4 + 0.2) / zoomed
    const bottom = CAM_Y - 1 / zoomed - 0.08
    if (Math.abs(extent - built.extent) > 0.15 || Math.abs(bottom - built.bottom) > 0.08) rebuild({ extent, bottom })
  }

  const drawQuad = (prog, dest, setup) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dest ? dest.fbo : null)
    gl.viewport(0, 0, dest ? dest.width : canvas.width, dest ? dest.height : canvas.height)
    gl.useProgram(prog.p)
    setup(prog.u)
    gl.bindVertexArray(quad)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  const bindTex = (unit, tex, location) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(location, unit)
  }

  const downsample = (from, to, threshold) =>
    drawQuad(copy, to, u => {
      bindTex(0, from.tex, u.u_tex)
      gl.uniform2f(u.u_texel, 1 / from.width, 1 / from.height)
      gl.uniform1f(u.u_threshold, threshold)
    })

  const blurPass = (from, to, dx, dy, spread) =>
    drawQuad(blur, to, u => {
      bindTex(0, from.tex, u.u_tex)
      gl.uniform2f(u.u_dir, (dx * spread) / from.width, (dy * spread) / from.height)
    })

  const frame = state => {
    resize()
    const aspect = canvas.width / canvas.height
    const cssW = canvas.clientWidth || window.innerWidth
    const cssH = canvas.clientHeight || window.innerHeight
    const shift = (state.centerPx - cssW / 2) / (cssH / 2)
    const zoom = zoomFor(state.freePx / (cssH / 2))
    const reveal = revealAt(state.build)
    // The head's figures that are one per frame, worked out once here.
    const pose = { head: state.head, sway: state.sway }
    const head = headFrame(pose, state.time, state.think)
    // The heart's glow as the shoulders turn it, how full it is, its beat.
    const since = state.sinceBeat ?? 9
    const heart = [
      HEART[0] * Math.cos(state.sway[2]) + 0.2 * Math.sin(state.sway[2]),
      HEART[1],
      pulseAt(since),
      since,
    ]

    // Particles.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.scene.fbo)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(particles.p)
    const u = particles.u
    gl.uniform2f(u.u_view, aspect, 1)
    gl.uniform1f(u.u_shift, shift)
    gl.uniform1f(u.u_zoom, zoom)
    gl.uniform1f(u.u_time, state.time)
    gl.uniform1f(u.u_flow, state.flow)
    gl.uniform1f(u.u_level, state.level)
    gl.uniform1f(u.u_speak, state.speak)
    gl.uniform1f(u.u_think, state.think)
    gl.uniform1f(u.u_listen, state.listen)
    gl.uniform1f(u.u_build, state.build)
    gl.uniform1f(u.u_reveal, reveal)
    gl.uniform1f(u.u_px, canvas.height / 1000)
    gl.uniform1f(u.u_gain, 1.2)
    gl.uniform1f(u.u_onset, state.onset)
    gl.uniform1f(u.u_offset, state.offset)
    gl.uniform1f(u.u_mic, state.mic)
    gl.uniform1f(u.u_ear, state.ear)
    gl.uniform4fv(u.u_head, state.head)
    gl.uniform4fv(u.u_sway, state.sway)
    gl.uniform4fv(u.u_heart, heart)
    gl.uniform2fv(u.u_core, head.core)
    gl.uniform2fv(u.u_crown, head.crown)
    gl.uniform3fv(u['u_orbits[0]'], head.orbits)
    bindTex(1, shape, u.u_shape)
    gl.uniform2f(u.u_res, canvas.width, canvas.height)
    gl.bindVertexArray(cloud)
    gl.drawArrays(gl.POINTS, 0, count)
    gl.disable(gl.BLEND)

    // Glow.
    downsample(targets.scene, targets.half, 0.08)
    downsample(targets.half, targets.q1, 0.0)
    blurPass(targets.q1, targets.q2, 1, 0, 1.0)
    blurPass(targets.q2, targets.q1, 0, 1, 1.0)
    downsample(targets.q1, targets.e1, 0.0)
    blurPass(targets.e1, targets.e2, 1, 0, 1.6)
    blurPass(targets.e2, targets.e1, 0, 1, 1.6)

    // Compose.
    drawQuad(compose, null, cu => {
      bindTex(0, targets.scene.tex, cu.u_scene)
      bindTex(1, targets.q1.tex, cu.u_bloomA)
      bindTex(2, targets.e1.tex, cu.u_bloomB)
      gl.uniform2f(cu.u_view, aspect, 1)
      gl.uniform1f(cu.u_shift, shift)
      gl.uniform1f(cu.u_zoom, zoom)
      gl.uniform1f(cu.u_time, state.time)
      gl.uniform1f(cu.u_level, state.level)
      gl.uniform1f(cu.u_speak, state.speak)
      gl.uniform1f(cu.u_think, state.think)
      gl.uniform1f(cu.u_build, state.build)
      gl.uniform1f(cu.u_reveal, reveal)
      gl.uniform4fv(cu.u_head, state.head)
      gl.uniform4fv(cu.u_sway, state.sway)
      gl.uniform4fv(cu.u_heart, heart)
      gl.uniform2fv(cu.u_core, head.core)
      gl.uniform2fv(cu.u_crown, head.crown)
      gl.uniform3fv(cu['u_orbits[0]'], head.orbits)
    })

    return { shift, zoom }
  }

  /** Where a world point lands on the page, in CSS pixels, for the HUD labels. */
  const toScreen = (x, y, shift, zoom) => {
    const cssW = canvas.clientWidth || window.innerWidth
    const cssH = canvas.clientHeight || window.innerHeight
    const wx = x * zoom + shift
    const wy = (y - CAM_Y) * zoom
    return [cssW / 2 + (wx * cssH) / 2, cssH / 2 - (wy * cssH) / 2]
  }

  resize()
  return { frame, toScreen, particleCount: () => count }
}
