// The status beside the robot's head: a panel in the color of what the robot
// is doing (blue listening, green thinking, white speaking, violet at work,
// pink with agents, red on a failure; bored, asleep, startled awake or proud
// when nobody needs it), a leader line from the temple to it
// and a faint rain of glyphs behind its text. A new word decodes itself out
// of katakana, as on the screens in The Matrix; under it lines of code tick
// out what the robot is doing, typed in the same way. A word holds a moment
// before the next one, so quick calls do not keep it scrambling.

/** What the robot is doing, by color: the monitor's trace and the status share them. */
export const COLORS = {
  intro: '#E8ECF6',
  listen: '#5BB8FF',
  think: '#2EE58F',
  speak: '#F2F2F0',
  tools: '#B98CFF',
  agents: '#FF6FCF',
  fail: '#FF3D5A',
  bored: '#5BB8FF',
  sleep: '#4A63D9',
  wake: '#FFE14D',
  proud: '#FFC93C',
}

/** The robot's states in words. */
export const WORDS = {
  listen: 'СЛУШАЮ',
  think: 'ДУМАЮ',
  speak: 'ГОВОРЮ',
  tools: 'ВЫПОЛНЯЮ',
  agents: 'ФОНОВЫЕ ЗАДАЧИ',
  fail: 'СБОЙ',
  bored: 'СКУЧАЮ',
  sleep: 'СПЛЮ',
  wake: 'А? НЕ СПЛЮ!',
  proud: 'ДОВОЛЕН',
}

/** The intro's word, with how far the figure has assembled. */
export const assembling = build => `СБОРКА… ${Math.min(99, Math.floor(build * 100))}%`

/** Glyphs a word or a line flickers through before it settles. */
const SCRAMBLE = 'ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
/** How long a new word takes to settle, how long it stays at least, how long a line types, in milliseconds. */
const DECODE_MS = 520
const HOLD_MS = 1500
const TYPE_MS = 380
/** A new line of code every so often, and how many show. */
const LINE_MS = 1100
const LINES = 3
/** How often the rain behind the text is drawn, in milliseconds. */
const RAIN_MS = 66

const scramble = () => SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]
const hex = n => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('')
const bar = (value, n = 8) => {
  const full = Math.max(0, Math.min(n, Math.round(value * n)))
  return '▮'.repeat(full) + '▯'.repeat(n - full)
}
const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/**
 * The lines of code each state ticks out, in turn, from what the robot is
 * doing now: `facts` { bpm, mic, level, doing, running, context }.
 */
const CODE = {
  intro: () => [`> сборка ядра 0x${hex(4)}`, `> калибровка ${hex(6)} … ok`, `> связь 0x${hex(4)}:${hex(4)}`],
  listen: f => [`> канал открыт · пульс ${f.bpm}`, `> mic ${bar(f.mic)}`, `> жду ввод 0x${hex(4)}`],
  think: f => [`> разбор контекста ${f.context ?? '—'}%`, `> ветка 0x${hex(6)} … ok`, `> пульс ${f.bpm} · ${hex(8)}`],
  speak: f => [`> синтез голоса ${bar(f.level)}`, `> поток eugene · 48 кГц`, `> слово 0x${hex(4)}:${hex(4)}`],
  tools: f => [`> exec ${cut(f.doing || 'команда', 24)}`, `> в работе: ${f.running}`, `> pid ${hex(5)} · пульс ${f.bpm}`],
  agents: f => [`> агенты в работе: ${f.running}`, `> sync 0x${hex(6)}`, `> пульс ${f.bpm}`],
  fail: f => [`> ERR ${cut(f.doing || 'вызов', 24)}`, `> trace 0x${hex(8)}`, `> повтор … ${hex(2)}`],
  bored: f => [`> клиентов нет · пульс ${f.bpm}`, `> зевок 0x${hex(4)}`, `> жду ввод · ${hex(6)}`],
  sleep: f => [`> режим сна · пульс ${f.bpm}`, `> z z z 0x${hex(4)}`, `> вход по голосу`],
  wake: f => [`> подъём! пульс ${f.bpm}`, `> я не спал 0x${hex(4)}`, `> канал открыт`],
  proud: f => [`> похвала принята`, `> самооценка ${bar(1)}`, `> пульс ${f.bpm} · ${hex(4)}`],
}

/** `text` typed in `p` of the way (0 to 1): settled up to there, scrambling just past, blank after. */
const typed = (text, p) =>
  [...text]
    .map((char, i) => {
      const at = i / Math.max(1, text.length)
      if (char === ' ' || at < p - 0.12) return char
      return at < p ? scramble() : ' '
    })
    .join('')
    .trimEnd()

/** A segment of the leader line from (x0, y0) to (x1, y1): one thin bar, turned. */
const lay = (bar, x0, y0, x1, y1) => {
  const length = Math.hypot(x1 - x0, y1 - y0)
  const angle = Math.atan2(y1 - y0, x1 - x0)
  bar.style.width = `${length.toFixed(1)}px`
  bar.style.transform = `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px) rotate(${angle.toFixed(4)}rad)`
}

/**
 * The panel: `show(word, state, beat, label, anchor, facts)` sets the word
 * (decoding it if new) and the state's color, the pulse (1 on a heartbeat,
 * fading to 0), where the panel and the line's anchor on the head sit, in
 * CSS pixels, and what the lines of code tell. `small` gets the same word for
 * the status line in the corner.
 *
 * Everything that moves each frame moves by transform or opacity alone; the
 * text changes only while it types, and the rain is a small canvas drawn a
 * few times a second.
 */
export function createStatus({ label, word, glow, dot, code, caption, rain, segments, anchor, small, smallDot }) {
  let target = ''
  let since = 0
  let middle = 0
  let placed = ''
  let pulse = -1
  let state = ''
  let lines = []
  let nextLine = 0
  let turn = 0
  let rainAt = 0
  const drops = []

  const decoded = now => {
    const p = (now - since) / DECODE_MS
    if (p >= 1) return target
    return [...target]
      .map((char, i) => (char === ' ' || p > (i + 1) / (target.length + 1) ? char : scramble()))
      .join('')
  }

  const paintRain = (now, color) => {
    const ctx = rain.getContext('2d')
    const width = rain.clientWidth
    const height = rain.clientHeight
    if (!width || !height) return
    if (rain.width !== width || rain.height !== height) {
      rain.width = width
      rain.height = height
      drops.length = 0
    }
    const size = 11
    const columns = Math.ceil(width / size)
    while (drops.length < columns) drops.push({ y: Math.random() * height, speed: 30 + Math.random() * 70 })
    const dt = rainAt ? Math.min(0.2, (now - rainAt) / 1000) : 0
    ctx.clearRect(0, 0, width, height)
    ctx.font = `${size}px "Hiragino Kaku Gothic ProN", "Hiragino Sans", monospace`
    ctx.fillStyle = color
    drops.forEach((drop, i) => {
      drop.y += drop.speed * dt
      if (drop.y > height + size * 6) Object.assign(drop, { y: -Math.random() * height * 0.5, speed: 30 + Math.random() * 70 })
      for (let k = 0; k < 6; k++) {
        ctx.globalAlpha = (1 - k / 6) * 0.9
        ctx.fillText(scramble(), i * size, drop.y - k * size)
      }
    })
    ctx.globalAlpha = 1
  }

  window.addEventListener('resize', () => (middle = 0))

  return {
    show(wanted, mood, beat, [lx, ly], [ax, ay], facts) {
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

      // A new state: its color everywhere, its lines of code from the top.
      const kind = target.startsWith('СБОРКА') ? 'intro' : mood
      if (kind !== state) {
        state = kind
        document.documentElement.style.setProperty('--state', COLORS[kind])
        caption.textContent = `СТАТУС · 0x${hex(4)}`
        lines = []
        nextLine = now
        turn = 0
      }
      if (now >= nextLine) {
        const pool = CODE[state](facts)
        lines = [...lines, { text: pool[turn % pool.length], at: now }].slice(-LINES)
        turn += 1
        nextLine = now + LINE_MS
      }
      const text = lines.map(line => typed(line.text, (now - line.at) / TYPE_MS)).join('\n')
      if (code.textContent !== text) code.textContent = text

      if (now - rainAt >= RAIN_MS) {
        paintRain(now, COLORS[state])
        rainAt = now
      }

      // Where it all sits, rewritten only when it moved a pixel.
      const where = `${Math.round(lx)},${Math.round(ly)},${Math.round(ax)},${Math.round(ay)}`
      if (where !== placed || !middle) {
        placed = where
        if (!middle) middle = word.parentElement.offsetTop + word.parentElement.offsetHeight / 2
        label.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`
        // The leader: from the temple out and up, then along to the word.
        const wy = ly + middle
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
        for (const one of segments) one.style.opacity = String(0.55 + 0.45 * step)
      }
    },
  }
}
