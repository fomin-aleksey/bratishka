// The monitor on the left: the robot's vital signs, as a ward's monitor shows
// a patient's. A cardiogram sweeps across in the color of what it is doing
// and beats at that pace; every tool call is a tall spike, a failed one a red
// one and an arrhythmia. Below it the session's figures as a body's: oxygen
// for the context still free, blood pressure for the rate limits, and a feed
// of what it is doing.

import { WORDS } from './status.js'

/** What it is doing, by the trace's color and its resting pulse; its word is in status.js. */
const STATES = {
  listen: { color: '#5BB8FF', bpm: 62 },
  think: { color: '#2EE58F', bpm: 88 },
  speak: { color: '#F2F2F0', bpm: 100 },
  tools: { color: '#FFB21E', bpm: 116 },
  agents: { color: '#FF7A2E', bpm: 124 },
  fail: { color: '#FF3D5A', bpm: 138 },
}
const AMBER = '#FFB21E'
const RED = '#FF3D5A'
const WHITE = '#F2F2F0'

/** How fast the trace sweeps, in CSS pixels a second, and the blank gap ahead of it. */
const SWEEP = 84
const GAP = 16
/** How many calls the feed shows. */
const FEED = 5

/** What a call does, in the first person. */
const DOING = {
  Read: 'Читаю файл',
  Edit: 'Правлю файл',
  Write: 'Пишу файл',
  NotebookEdit: 'Правлю ноутбук',
  Bash: 'Выполняю команду',
  Grep: 'Ищу в коде',
  Glob: 'Ищу файлы',
  Skill: 'Загружаю скилл',
  WebFetch: 'Читаю страницу',
  WebSearch: 'Ищу в сети',
  ToolSearch: 'Подбираю инструмент',
  AskUserQuestion: 'Жду твоего решения',
  Agent: 'Запускаю агента',
  Artifact: 'Публикую страницу',
  Workflow: 'Запускаю процесс',
  SendMessage: 'Пишу агенту',
}

const doingOf = action => {
  const mcp = /^mcp__.+?__(.+)$/.exec(action.tool)
  const verb = DOING[action.tool] ?? (mcp ? `Инструмент ${mcp[1]}` : `Использую ${action.tool}`)
  return action.sub ? `Агент: ${verb.toLowerCase()}` : verb
}

const g = (x, at, width) => Math.exp(-(((x - at) / width) ** 2))

/** One heartbeat at phase 0 to 1: the P wave, the QRS and the T wave; 0 at rest, 1 at the R peak. */
const beat = (phase, strength) =>
  0.12 * g(phase, 0.15, 0.035) -
  0.12 * g(phase, 0.285, 0.008) +
  strength * g(phase, 0.31, 0.009) -
  0.28 * g(phase, 0.335, 0.01) +
  0.26 * g(phase, 0.56, 0.05)

/** A tall spike of a call, `age` seconds after it: a failed one dips deep below the line after. */
const spike = (age, failed) => (failed ? 1.5 : 1.25) * g(age, 0.03, 0.012) - (failed ? 0.9 : 0.35) * g(age, 0.06, 0.012)

const pad = n => String(n).padStart(2, '0')
const clock = seconds => {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}
const timeOf = at => {
  const d = new Date(at * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A model's id as a name: claude-opus-5-5 as OPUS 5.5. */
export const modelName = id => {
  const parts = String(id || '').replace(/^claude-/, '').replace(/\[.*\]$/, '').split('-')
  const name = parts.filter(part => !/^\d+$/.test(part)).join(' ')
  const version = parts.filter(part => /^\d{1,2}$/.test(part)).join('.')
  return `${name} ${version}`.trim().toUpperCase() || '—'
}

/** The color of a figure: white while fine, amber past `warn`, red past `alarm`. */
const tone = (value, warn, alarm) => (value >= alarm ? RED : value >= warn ? AMBER : WHITE)

/**
 * The monitor in `root`, drawn into its canvas. `frame(dt, { state, level,
 * mic })` advances the trace and answers how long ago the heart last beat (it
 * beats on while the monitor is folded away); `vitals(figures)` and
 * `action(call)` take what the server sends.
 */
export function createMonitor(root) {
  const $ = name => root.querySelector(`[data-m="${name}"]`)
  const canvas = $('trace')
  const ctx = canvas.getContext('2d')
  const trace = { width: 0, height: 0, ys: new Float32Array(0), colors: [], head: 0, time: 0 }
  const heart = { phase: 0, period: 1, bpm: 62, shown: 62, strength: 1, lastBeat: 0 }
  const spikes = []
  let vitals = null
  let vitalsAt = 0
  let actions = []
  let shownFeed = null

  const fit = () => {
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(10, Math.round(canvas.clientWidth))
    const height = Math.max(10, Math.round(canvas.clientHeight))
    if (width === trace.width && height === trace.height) return
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    Object.assign(trace, { width, height, ys: new Float32Array(width), colors: new Array(width).fill(null), head: 0 })
  }

  /** The trace's value at the write head now: the beat, the voice, the calls' spikes. */
  const sample = (dt, { state, level, mic }) => {
    const s = STATES[state]
    // The pulse: steps toward the state's rate, with the voice on top while it speaks.
    const target = s.bpm + (state === 'speak' ? 22 * level : 0)
    heart.bpm += (target - heart.bpm) * Math.min(1, dt * 1.5)
    heart.phase += dt / heart.period
    if (heart.phase >= 1) {
      heart.phase -= 1
      // A failure beats out of step: each interval its own, some beats weak.
      const irregular = state === 'fail' ? 0.45 + Math.random() * 1.1 : 1
      heart.period = (60 / heart.bpm) * irregular
      heart.strength = state === 'fail' && Math.random() < 0.3 ? 0.45 : 1 + (state === 'speak' ? 0.6 * level : 0)
      heart.shown = Math.round(60 / heart.period)
      heart.lastBeat = trace.time
    }
    let v = beat(heart.phase, heart.strength)
    if (state === 'speak') v += level * 0.22 * Math.sin(trace.time * 63) * Math.sin(trace.time * 17.3)
    if (state === 'listen') v += mic * 0.12 * Math.sin(trace.time * 47) * Math.sin(trace.time * 9.1)
    for (const one of spikes) v += spike(trace.time - one.at, one.failed)
    return v
  }

  const advance = (dt, signs) => {
    fit()
    const step = 1 / SWEEP
    let left = dt
    // Column by column: a slow frame writes a few at once.
    while (left > 0) {
      const slice = Math.min(step, left)
      left -= slice
      trace.time += slice
      const v = sample(slice, signs)
      trace.head += slice * SWEEP
      if (trace.head >= trace.width) trace.head -= trace.width
      const x = Math.floor(trace.head)
      trace.ys[x] = v
      trace.colors[x] = STATES[signs.state].color
      for (let k = 1; k <= GAP; k++) trace.colors[(x + k) % trace.width] = null
    }
    while (spikes.length && trace.time - spikes[0].at > 1) spikes.shift()
  }

  const draw = () => {
    const { width, height, ys, colors } = trace
    ctx.clearRect(0, 0, width, height)
    // The grid of a ward's monitor, faint.
    ctx.strokeStyle = 'rgba(232, 236, 246, 0.06)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = 0.5; x < width; x += 20) ctx.moveTo(x, 0), ctx.lineTo(x, height)
    for (let y = 0.5; y < height; y += 20) ctx.moveTo(0, y), ctx.lineTo(width, y)
    ctx.stroke()
    const base = height * 0.62
    const scale = height * 0.42
    const yOf = x => base - ys[x] * scale
    // Each run of one color is one path, drawn three times, wide and faint
    // to thin and bright: a glow without the canvas's costly shadow blur.
    for (const [lineWidth, alpha] of [
      [6, 0.12],
      [3, 0.3],
      [1.5, 1],
    ]) {
      ctx.lineWidth = lineWidth
      ctx.globalAlpha = alpha
      ctx.lineJoin = 'round'
      let x = 0
      while (x < width) {
        if (colors[x] === null) {
          x++
          continue
        }
        const color = colors[x]
        ctx.strokeStyle = color
        ctx.beginPath()
        ctx.moveTo(x, yOf(x))
        let end = x
        while (end + 1 < width && colors[end + 1] === color) {
          end++
          ctx.lineTo(end, yOf(end))
        }
        // Into the first column of the next color, so a change has no seam.
        if (end + 1 < width && colors[end + 1] !== null) ctx.lineTo(end + 1, yOf(end + 1))
        ctx.stroke()
        x = end + 1
      }
    }
    // The write head: a bright point in a halo of its color.
    const hx = Math.floor(trace.head)
    if (colors[hx]) {
      for (const [radius, alpha, color] of [
        [6, 0.25, colors[hx]],
        [2.4, 1, '#ffffff'],
      ]) {
        ctx.globalAlpha = alpha
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(hx, yOf(hx), radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  const text = (name, value) => {
    const el = $(name)
    if (el && el.textContent !== value) el.textContent = value
  }
  const paint = (name, color) => {
    const el = $(name)
    if (el && el.style.color !== color) el.style.color = color
  }

  const figures = () => {
    if (vitals) text('session', clock(((vitals.ageMs ?? 0) + (Date.now() - vitalsAt)) / 1000))
    if (!vitals) return
    text('model', modelName(vitals.model))
    text('cost', vitals.usd === null ? '—' : `$${vitals.usd.toFixed(2)}`)
    // Oxygen: the share of the context still free.
    const free = vitals.context === null ? null : Math.max(0, 100 - vitals.context)
    text('oxygen', free === null ? '—' : `${Math.round(free)}%`)
    const oxygenTone = free === null ? WHITE : tone(100 - free, 65, 88)
    paint('oxygen', oxygenTone)
    const bar = $('oxygenBar')
    bar.style.width = `${free ?? 0}%`
    bar.style.background = oxygenTone
    // Blood pressure: how much of the five-hour and the week's limits is
    // used, in percent, each in its own color.
    for (const [name, kind] of [
      ['five', 'five_hour'],
      ['week', 'seven_day'],
    ]) {
      const used = vitals.limits.find(one => one.kind === kind)?.used
      text(name, used === undefined ? '—' : `${Math.round(used)}%`)
      paint(name, used === undefined ? WHITE : tone(used, 60, 85))
    }
    text('pressureNote', vitals.limits.length ? 'израсходовано' : 'лимитов нет')
  }

  const feed = () => {
    const rows = actions.slice(-FEED).reverse()
    const key = rows.map(one => `${one.id}:${one.state}`).join('|')
    if (key === shownFeed) return
    shownFeed = key
    const list = $('feed')
    list.replaceChildren(
      ...rows.map(one => {
        const row = document.createElement('li')
        row.className = `m-row ${one.state}`
        const dot = document.createElement('span')
        dot.className = 'm-dot'
        const what = document.createElement('span')
        what.className = 'm-what'
        what.textContent = doingOf(one)
        const detail = document.createElement('span')
        detail.className = 'm-detail'
        detail.textContent = one.detail
        const at = document.createElement('span')
        at.className = 'm-at'
        at.textContent = timeOf(one.at)
        row.append(dot, what, at, detail)
        return row
      }),
    )
    if (!rows.length) {
      const empty = document.createElement('li')
      empty.className = 'm-empty'
      empty.textContent = 'Пока ничего не делал'
      list.append(empty)
    }
  }

  return {
    frame(dt, signs) {
      if (root.hidden) {
        trace.time += dt
        sample(dt, signs)
        return { sinceBeat: trace.time - heart.lastBeat }
      }
      advance(dt, signs)
      draw()
      const s = STATES[signs.state]
      text('state', WORDS[signs.state])
      paint('state', s.color)
      paint('stateDot', s.color)
      if ($('stateDot').style.background !== s.color) $('stateDot').style.background = s.color
      text('bpm', String(heart.shown))
      // The heart lights up on each beat, in steps.
      const glow = String(Math.round((0.35 + 0.65 * Math.exp(-(trace.time - heart.lastBeat) * 6)) * 20) / 20)
      if ($('heart').style.opacity !== glow) $('heart').style.opacity = glow
      paint('heart', s.color)
      figures()
      feed()
      return { sinceBeat: trace.time - heart.lastBeat }
    },
    vitals(next) {
      if (!next) return
      vitals = next
      vitalsAt = Date.now()
    },
    action(call) {
      const known = actions.some(one => one.id === call.id)
      actions = known
        ? actions.map(one => (one.id === call.id ? { ...one, state: call.state } : one))
        : [...actions, call].slice(-12)
      // A call shows on the trace as it starts; a failure once more as it ends.
      if (call.state === 'run' || call.state === 'fail') spikes.push({ at: trace.time, failed: call.state === 'fail' })
    },
    /** The feed as a reloaded window finds it: no spikes for calls long done. */
    load(list) {
      actions = Array.isArray(list) ? list.slice(-12) : []
    },
    actions: () => actions,
  }
}

/** The state the monitor shows: talking, a fresh failure, calls under way, thinking or listening. */
export function monitorState({ talking, thinking, actions, failAt, now }) {
  if (talking) return 'speak'
  if (now - failAt < 4) return 'fail'
  const running = actions.filter(one => one.state === 'run' && now - one.at < 600)
  if (running.some(one => one.sub || one.tool === 'Agent')) return 'agents'
  const recent = actions.some(one => now - one.at < 1.2)
  if (running.length || (thinking && recent)) return 'tools'
  if (thinking) return 'think'
  return 'listen'
}
