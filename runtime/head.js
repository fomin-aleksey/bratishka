// The living head. It turns, nods and tilts about the top of the neck as a
// head does, in depth: the slices of the face slide round it, what comes
// nearer grows a little and what goes round the back is hidden. While it
// thinks the red fire of its core splits into sparks circling inside it.
//
// This file holds the particles of the sparks' trails, the GLSL the shaders
// share for the head's pose and the orbits, and the same math in JS for what
// is one figure per frame (the core, the head's centre, the sparks now): the
// shaders take those as uniforms instead of working them out per pixel. The
// pose itself comes per frame from alive.js.

import { HEAD, KIND } from './kinds.js'

const f = x => x.toFixed(4)

/** The sparks the core splits into while thinking, and the points in each one's trail. */
const ORBITS = 4
const TRAIL = 1100
/** The core's fire and how far in front of the head's axis it burns; what the head turns about; where the sparks circle. */
const CORE = [0, 0.22]
const CORE_DEPTH = 0.16
const PIVOT = [0, 0.03]
const ORBIT_CENTER = [0, 0.44]
const PITCH = 0.4
/** How much bigger a point looks for each unit it comes nearer: the head's depth. */
const NEAR = 0.45
/**
 * How much of a point's height above the head's centre tips its facing as the
 * head nods: the head's width over its height, squared, as on an ellipsoid.
 */
const TIP = 0.45

/**
 * GLSL for the shaders that place the head: its pose, the core's fire and
 * the orbits. Needs HEAD and CORE declared before it.
 */
export const HEAD_GLSL = `
// yaw, pitch, roll, breath; and dx, dy, the shoulders' yaw and roll.
uniform vec4 u_head;
uniform vec4 u_sway;
// This frame's figures, from headFrame() below.
uniform vec2 u_core;
uniform vec2 u_crown;
uniform vec3 u_orbits[${ORBITS}];
// The color of what the robot is doing (status.js): the sparks it thinks with take it.
uniform vec3 u_tint;
const vec2 PIVOT = vec2(${f(PIVOT[0])}, ${f(PIVOT[1])});
const float CORE_DEPTH = ${f(CORE_DEPTH)};
const float NEAR = ${f(NEAR)};
const float TIP = ${f(TIP)};
// Up in the skull, above the eyes: where the brain would be.
const vec2 ORBIT_CENTER = vec2(${f(ORBIT_CENTER[0])}, ${f(ORBIT_CENTER[1])});

/**
 * A point of the head \`z\` in front of its axis, turned with the head about
 * the top of the neck: yaw, then pitch. \`lean\` is how its slice bows to the
 * camera, so the slices bend as the head turns. A point of the outline
 * (\`outline\` 1) keeps to it as the head turns about its own axis.
 * Returns where it lands; how far in front of the axis it is now; and how
 * much it faces the camera, below 0 when it has gone round the back.
 */
vec4 turnHead(vec2 p, float z, float lean, float outline) {
  vec3 q = vec3(p.x, p.y - lean * z - PIVOT.y, z);
  float sy = sin(u_head.x);
  float cy = cos(u_head.x);
  q = mix(vec3(q.x * cy + q.z * sy, q.y, q.z * cy - q.x * sy), q, outline);
  float facing = q.z;
  float above = q.y + PIVOT.y - HEAD.y;
  float sp = sin(u_head.y);
  float cp = cos(u_head.y);
  q = vec3(q.x, q.y * cp + q.z * sp, q.z * cp - q.y * sp);
  facing = facing * cp - above * TIP * sp;
  vec2 s = vec2(q.x, PIVOT.y + q.y + lean * q.z);
  // What comes nearer looks a little bigger.
  s = HEAD + (s - HEAD) * (1.0 + NEAR * (q.z - z));
  return vec4(s, q.z, facing);
}

/** The head's roll about the top of the neck and its sway, \`w\` of it. */
vec2 swayHead(vec2 p, float w) {
  float a = u_head.z * w;
  vec2 d = p - PIVOT;
  return PIVOT + vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a)) + u_sway.xy * w;
}

/** A head point posed: where it lands, how far in front it is now, how much it faces the camera. */
vec4 poseHeadPoint(vec2 p, float z, float lean, float outline) {
  vec4 t = turnHead(p, z, lean, outline);
  return vec4(swayHead(t.xy, 1.0), t.zw);
}

vec2 poseHead(vec2 p, float z, float lean) {
  return poseHeadPoint(p, z, lean, 0.0).xy;
}

/** Where the core's fire burns now. */
vec2 coreNow() {
  return u_core;
}

/**
 * Spark \`i\` of the core split while thinking, at time \`t\`: where it is,
 * and in z how far in front it is, 0 at the back of its orbit to 1 in front.
 * Each circles in a plane of its own, seen from a little above; as thinking
 * sets in they rise out of the core and spiral up into the skull.
 */
vec3 orbitAt(int i, float t, float think) {
  float fi = float(i);
  float dir = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
  float a = t * dir * (1.7 + 0.3 * fi) + fi * 1.9;
  float r = 0.125 - 0.01 * fi;
  vec3 q = vec3(cos(a), 0.0, sin(a)) * r;
  q = vec3(q.x, -q.z * ${f(Math.sin(PITCH))}, q.z * ${f(Math.cos(PITCH))});
  float roll = -0.7 + 0.47 * fi;
  q = vec3(q.x * cos(roll) - q.y * sin(roll), q.x * sin(roll) + q.y * cos(roll), q.z);
  float k = smoothstep(0.0, 1.0, think);
  float spread = 0.12 + 0.88 * k;
  vec2 p = poseHead(mix(CORE, ORBIT_CENTER, k) + q.xy * spread, CORE_DEPTH * (1.0 - k) + q.z * spread, 0.0);
  return vec3(p, 0.5 + 0.5 * q.z / r);
}`

/**
 * The vertex shader's branch for the sparks' kind, read after the other
 * kinds. Uses the shader's locals: pos, col, alpha, size.
 */
export const HEAD_KINDS = `
  } else if (kind == ${KIND.orbit}) {
    // A spark of the core split while thinking, circling inside the head,
    // its trail behind it; dimmer on the far side of its orbit. In the color
    // of what the robot is doing, white-hot at the spark itself.
    vec3 o = orbitAt(int(a_p.x + 0.5), u_time - a_p.y * 1.0, u_think);
    pos = o.xy + a_p.zw * 0.0025 * (0.3 + a_p.y);
    col = mix(mix(u_tint, vec3(1.0), 0.55), u_tint, smoothstep(0.0, 0.6, a_p.y));
    alpha = pow(1.0 - a_p.y, 1.3) * (0.35 + 0.65 * o.z) * smoothstep(0.05, 0.5, u_think) * 1.6;
    size *= 0.7 + 0.5 * o.z;`

// The same pose and orbits in JS, once a frame, for points not on a slice
// (no lean) and off the outline. `pose` is { head: [yaw, pitch, roll, breath],
// sway: [dx, dy, ...] }.

const turnHead = ({ head: [yaw, pitch] }, x, y, z) => {
  const x1 = x * Math.cos(yaw) + z * Math.sin(yaw)
  const z1 = z * Math.cos(yaw) - x * Math.sin(yaw)
  const y1 = y - PIVOT[1]
  const y2 = y1 * Math.cos(pitch) + z1 * Math.sin(pitch)
  const z2 = z1 * Math.cos(pitch) - y1 * Math.sin(pitch)
  const near = 1 + NEAR * (z2 - z)
  return [HEAD[0] + (x1 - HEAD[0]) * near, HEAD[1] + (PIVOT[1] + y2 - HEAD[1]) * near]
}

const swayHead = ({ head, sway }, [x, y], w) => {
  const a = head[2] * w
  const dx = x - PIVOT[0]
  const dy = y - PIVOT[1]
  return [
    PIVOT[0] + dx * Math.cos(a) - dy * Math.sin(a) + sway[0] * w,
    PIVOT[1] + dx * Math.sin(a) + dy * Math.cos(a) + sway[1] * w,
  ]
}

const poseHead = (pose, x, y, z) => swayHead(pose, turnHead(pose, x, y, z), 1)

/** Spark `i` at time `t`, as orbitAt() in the GLSL: [x, y, front]. */
function orbitAt(pose, i, t, think) {
  const dir = i % 2 === 0 ? 1 : -1
  const a = t * dir * (1.7 + 0.3 * i) + i * 1.9
  const r = 0.125 - 0.01 * i
  const qx = Math.cos(a) * r
  const qz0 = Math.sin(a) * r
  const qy = -qz0 * Math.sin(PITCH)
  const qz = qz0 * Math.cos(PITCH)
  const roll = -0.7 + 0.47 * i
  const rx = qx * Math.cos(roll) - qy * Math.sin(roll)
  const ry = qx * Math.sin(roll) + qy * Math.cos(roll)
  const c = Math.min(1, Math.max(0, think))
  const k = c * c * (3 - 2 * c)
  const spread = 0.12 + 0.88 * k
  const cx = CORE[0] + (ORBIT_CENTER[0] - CORE[0]) * k
  const cy = CORE[1] + (ORBIT_CENTER[1] - CORE[1]) * k
  const [x, y] = poseHead(pose, cx + rx * spread, cy + ry * spread, CORE_DEPTH * (1 - k) + qz * spread)
  return [x, y, 0.5 + (0.5 * qz) / r]
}

/** This frame's figures for the shaders: the core, the head's centre, the sparks. */
export function headFrame(pose, time, think) {
  const orbits = new Float32Array(ORBITS * 3)
  for (let i = 0; i < ORBITS; i++) orbits.set(orbitAt(pose, i, time, think), i * 3)
  return { core: poseHead(pose, CORE[0], CORE[1], CORE_DEPTH), crown: swayHead(pose, HEAD, 1), orbits }
}

/** The sparks' trails: dense at the spark, thinning out behind it. */
export function buildOrbits(rnd, push) {
  for (let i = 0; i < ORBITS; i++) {
    for (let k = 0; k < TRAIL; k++) {
      const tau = Math.pow(k / TRAIL, 1.4)
      push(0, 0.22, i, tau, rnd() * 2 - 1, rnd() * 2 - 1, KIND.orbit, (1.0 + 1.6 * (1 - tau)) * (0.7 + 0.6 * rnd()), 1)
    }
  }
}
