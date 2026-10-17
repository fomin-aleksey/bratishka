// The status beside the robot's head, in Russian: an orange callout that
// pulses with the heartbeat on the monitor, a leader line from the temple
// to it, and a new word that decodes itself letter by letter, as on a
// screen in a film, when the state changes. A word holds a moment before the
// next one, so quick calls do not keep it scrambling.

/** Letters a word flickers through before it settles. */
const GLYPHS = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ0123456789#%*+'
/** How long a new word takes to settle, and how long it stays at least, in milliseconds. */
const DECODE_MS = 450
const HOLD_MS = 1500

/** The robot's states in words. */
export const WORDS = {
  listen: 'СЛУШАЮ',
  think: 'ДУМАЮ',
  speak: 'ГОВОРЮ',
  tools: 'ВЫПОЛНЯЮ',
  agents: 'ФОНОВЫЕ ЗАДАЧИ',
  fail: 'СБОЙ',
}

/** The intro's word, with how far the figure has assembled. */
export const assembling = build => `СБОРКА… ${Math.min(99, Math.floor(build * 100))}%`

/** A segment of the leader line from (x0, y0) to (x1, y1): one thin bar, turned. */
const lay = (bar, x0, y0, x1, y1) => {
  const length = Math.hypot(x1 - x0, y1 - y0)
  const angle = Math.atan2(y1 - y0, x1 - x0)
  bar.style.width = `${length.toFixed(1)}px`
  bar.style.transform = `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px) rotate(${angle.toFixed(4)}rad)`
}

/**
 * The callout: `show(word, beat, label, anchor)` sets the word (decoding it
 * if new), the pulse (1 on a heartbeat, fading to 0) and where the label and
 * the line's anchor on the head sit, in CSS pixels. `small` gets the same
 * word for the status line in the corner.
 *
 * Everything that moves each frame moves by transform or opacity alone, so
 * the browser composes it without painting anything anew.
 */
export function createStatus({ label, word, glow, dot, segments, anchor, small, smallDot }) {
  let target = ''
  let since = 0
  let height = 0
  let placed = ''
  let pulse = -1

  const decoded = now => {
    const p = (now - since) / DECODE_MS
    if (p >= 1) return target
    return [...target]
      .map((char, i) => {
        if (char === ' ' || p > (i + 1) / (target.length + 1)) return char
        return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
      })
      .join('')
  }

  window.addEventListener('resize', () => (height = 0))

  return {
    show(wanted, beat, [lx, ly], [ax, ay]) {
      const now = performance.now()
      // The intro's percent runs on; a new state waits out the word before it.
      const isIntro = wanted.startsWith('СБОРКА') && target.startsWith('СБОРКА')
      if (wanted !== target && (!target || isIntro || target.startsWith('СБОРКА') || now - since >= HOLD_MS)) {
        if (!isIntro) since = now
        target = wanted
      }
      const shown = decoded(now)
      if (word.textContent !== shown) word.textContent = shown
      if (small.textContent !== target) small.textContent = target

      // Where it all sits, rewritten only when it moved a pixel.
      const where = `${Math.round(lx)},${Math.round(ly)},${Math.round(ax)},${Math.round(ay)}`
      if (where !== placed) {
        placed = where
        if (!height) height = label.offsetHeight
        label.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`
        // The leader: from the temple out and up, then along to the word.
        const wy = ly + height * 0.68
        lay(segments[0], ax, ay, ax + 26, wy)
        lay(segments[1], ax + 26, wy, lx - 8, wy)
        anchor.style.translate = `${ax.toFixed(1)}px ${ay.toFixed(1)}px`
      }

      // The heartbeat: a glow's opacity and the dots' scale, in steps.
      const step = Math.round(beat * 25) / 25
      if (step !== pulse) {
        pulse = step
        glow.style.opacity = String(step)
        const scale = `scale(${(1 + 0.6 * step).toFixed(2)})`
        dot.style.transform = scale
        smallDot.style.transform = scale
        anchor.style.transform = `scale(${(1 + 0.9 * step).toFixed(2)})`
        for (const bar of segments) bar.style.opacity = String(0.55 + 0.45 * step)
      }
    },
  }
}
