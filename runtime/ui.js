// The robot window: events from the server, the speech queue, the analyser
// that lights the robot, subtitles, the text panel and the controls.

import { DEMO_VITALS, createLife, createMic, createTalk, demoCalls, demoCycle, fakeVoice } from './alive.js'
import { createMonitor, monitorState } from './monitor.js'
import { createRobot } from './robot.js'
import { WORDS, assembling, createStatus } from './status.js'

const $ = id => document.getElementById(id)

const saved = {
  get(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Private window or blocked storage: the panel just opens by default.
    }
  },
}

const params = new URLSearchParams(location.search)
// ?demo=speak fakes a voice (?demo=loud a loud one), ?demo=think the
// thinking state, ?demo=mic the person speaking into the microphone and
// ?demo=cycle all three in turn, to show the robot off without a
// conversation; ?panel=0 or 1 sets the text window, ?monitor=0 or 1 the
// monitor on the left; ?intro=0 skips the assembly.
const demo = params.get('demo')

/** How long the figure takes to assemble out of the orb when the window opens. */
const INTRO_SECONDS = 4.6
const skipIntro = params.get('intro') === '0'

const ui = {
  level: 'mid',
  status: demo === 'think' ? 'thinking' : 'idle',
  panelOpen: params.has('panel') ? params.get('panel') === '1' : saved.get('robot.panel') !== 'closed',
  monitorOpen: params.has('monitor') ? params.get('monitor') === '1' : saved.get('robot.monitor') !== 'closed',
  replaced: false,
}

// ------------------------------------------------------------------ overlay

function showOverlay(title, text, label, action) {
  $('overlayTitle').textContent = title
  $('overlayText').textContent = text
  $('overlayButton').textContent = label
  $('overlayButton').onclick = action
  $('overlay').hidden = false
}

let noticeTimer = 0
function showNotice(text, ms = 0) {
  clearTimeout(noticeTimer)
  $('notice').textContent = text
  $('notice').hidden = false
  if (ms) noticeTimer = setTimeout(hideNotice, ms)
}
function hideNotice() {
  $('notice').hidden = true
}

// ------------------------------------------------------------------ server

const TOKEN = document.querySelector('meta[name="robot-token"]')?.content ?? ''
const INSTANCE = document.querySelector('meta[name="robot-instance"]')?.content ?? ''

const post = (path, data = {}) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Robot-Token': TOKEN },
    body: JSON.stringify(data),
  }).catch(() => undefined)

// ------------------------------------------------------------------ audio

const audio = { ctx: null, analyser: null, wave: null }

function setupAudio() {
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.45
  analyser.minDecibels = -90
  analyser.maxDecibels = -22
  analyser.connect(ctx.destination)
  Object.assign(audio, { ctx, analyser, wave: new Float32Array(analyser.fftSize) })
  if (ctx.state !== 'running') {
    showNotice('Кликни по окну: браузер ждёт разрешения на звук')
    const unlock = () =>
      ctx.resume().then(() => {
        hideNotice()
        window.removeEventListener('pointerdown', unlock)
        window.removeEventListener('keydown', unlock)
      })
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  }
}

/**
 * The intro's sounds: the transforming while the figure assembles, the
 * impact with the shock that opens the mountains. Each is scheduled on the
 * intro's clock, so a slow load joins it where the picture already is.
 * Straight to the speakers, past the analyser, so they do not light the face.
 */
const INTRO_SOUNDS = [
  { url: 'sounds/transform.mp3', at: 0, gain: 0.85 },
  { url: 'sounds/impact.mp3', at: INTRO_SECONDS, gain: 0.45 },
]

async function playIntroSound() {
  const ctx = audio.ctx
  let buffers
  try {
    buffers = await Promise.all(
      INTRO_SOUNDS.map(sound =>
        fetch(sound.url)
          .then(response => {
            if (!response.ok) throw new Error(`${sound.url}: ${response.status}`)
            return response.arrayBuffer()
          })
          .then(bytes => ctx.decodeAudioData(bytes)),
      ),
    )
  } catch (error) {
    console.warn('intro sound skipped', error)
    return
  }
  const elapsed = (performance.now() - introStart) / 1000
  INTRO_SOUNDS.forEach((sound, i) => {
    const late = elapsed - sound.at
    if (late > buffers[i].duration - 0.5) return
    const source = ctx.createBufferSource()
    source.buffer = buffers[i]
    const gain = ctx.createGain()
    gain.gain.value = sound.gain
    source.connect(gain).connect(ctx.destination)
    if (late < 0) source.start(ctx.currentTime - late)
    else source.start(ctx.currentTime, late)
  })
}

/** When the intro's impact has died away, in seconds from the intro's start: the robot says hello then. */
const GREET_AT = INTRO_SECONDS + 4.8

/**
 * Once the robot has assembled, it greets the person, unless it is speaking
 * already. Only after the intro played: a skipped intro is a test or a render.
 */
function greetSoon() {
  if (skipIntro || demo) return
  const wait = GREET_AT * 1000 - (performance.now() - introStart)
  setTimeout(() => {
    if (ui.replaced || speech.busy || speech.queue.length > 0) return
    void post('/api/greet')
  }, Math.max(0, wait))
}

/** Plays the intro's sounds once the window may make sound; a sound already over by then is skipped. */
function introSound() {
  const ctx = audio.ctx
  if (!ctx || skipIntro) return
  if (ctx.state === 'running') {
    void playIntroSound()
    return
  }
  const once = () => {
    if (ctx.state !== 'running') return
    ctx.removeEventListener('statechange', once)
    void playIntroSound()
  }
  ctx.addEventListener('statechange', once)
}

// ------------------------------------------------------------------ speech queue

const speech = {
  queue: [],
  jobs: new Map(), // job -> { played, total }
  current: null, // { part, source, start, duration, words }
  busy: false,
  generation: 0,
  buffers: new Map(), // url -> Promise<AudioBuffer>
}

const jobOf = id => {
  if (!speech.jobs.has(id)) speech.jobs.set(id, { played: 0, total: null })
  return speech.jobs.get(id)
}

function load(url) {
  if (!speech.buffers.has(url)) {
    const loading = fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`wav ${response.status}`)
        return response.arrayBuffer()
      })
      .then(bytes => audio.ctx.decodeAudioData(bytes))
    speech.buffers.set(url, loading)
  }
  return speech.buffers.get(url)
}

function settle(id) {
  const job = speech.jobs.get(id)
  if (job && job.total !== null && job.played >= job.total) {
    speech.jobs.delete(id)
    post('/api/done', { job: id })
  }
}

function enqueuePart(part) {
  jobOf(part.job)
  speech.queue.push(part)
  load(part.url).catch(() => undefined)
  pump()
}

function endJob({ job, count }) {
  jobOf(job).total = count
  settle(job)
}

async function pump() {
  if (speech.busy || speech.queue.length === 0 || !audio.ctx) return
  speech.busy = true
  const generation = speech.generation
  const part = speech.queue.shift()
  try {
    const buffer = await load(part.url)
    if (generation !== speech.generation) return
    const source = audio.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(audio.analyser)
    const ended = new Promise(resolve => (source.onended = resolve))
    speech.current = { part, source, start: audio.ctx.currentTime, duration: buffer.duration, words: showSubtitle(part.text) }
    source.start()
    await ended
    if (generation !== speech.generation) return
    await new Promise(resolve => setTimeout(resolve, 110))
  } catch (error) {
    console.warn('part skipped', error)
  } finally {
    speech.buffers.delete(part.url)
    if (generation === speech.generation) {
      speech.current = null
      speech.busy = false
      jobOf(part.job).played += 1
      settle(part.job)
      if (speech.queue.length === 0) hideSubtitleSoon()
      pump()
    }
  }
}

function stopAll() {
  speech.generation += 1
  speech.queue = []
  if (speech.current) {
    try {
      speech.current.source.stop()
    } catch {
      // Already stopped.
    }
  }
  speech.current = null
  speech.busy = false
  for (const id of speech.jobs.keys()) post('/api/done', { job: id })
  speech.jobs.clear()
  speech.buffers.clear()
  hideSubtitleSoon(0)
}

// ------------------------------------------------------------------ subtitles

let subtitleTimer = 0

function showSubtitle(text) {
  clearTimeout(subtitleTimer)
  const box = $('subtitles')
  box.replaceChildren()
  const words = []
  let offset = 0
  const total = text.length || 1
  for (const word of text.split(/(\s+)/)) {
    if (/^\s+$/.test(word) || word === '') {
      box.append(document.createTextNode(word))
    } else {
      const span = document.createElement('span')
      span.textContent = word
      box.append(span)
      words.push({ span, at: offset / total })
    }
    offset += word.length
  }
  box.classList.add('on')
  return words
}

function hideSubtitleSoon(ms = 1400) {
  clearTimeout(subtitleTimer)
  subtitleTimer = setTimeout(() => $('subtitles').classList.remove('on'), ms)
}

function followSubtitle() {
  const now = speech.current
  if (!now || !audio.ctx) return
  const fraction = (audio.ctx.currentTime - now.start) / Math.max(0.1, now.duration)
  for (const word of now.words) word.span.classList.toggle('said', word.at <= fraction + 0.04)
}

// ------------------------------------------------------------------ text panel

const escapeHtml = text =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function inline(text) {
  return text
    .split(/(`[^`\n]+`)/g)
    .map(piece => {
      if (piece.length > 1 && piece.startsWith('`') && piece.endsWith('`')) {
        return `<code>${escapeHtml(piece.slice(1, -1))}</code>`
      }
      return escapeHtml(piece)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
          /^https?:\/\//.test(href)
            ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
            : `<span class="ref">${label}</span>`,
        )
    })
    .join('')
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/
const BLOCK_START = /^\s*(```|#{1,6}\s|>|\||([-*+]|\d+[.)])\s+)/

function markdown(source) {
  const lines = source.replace(/\r/g, '').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      const body = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i += 1
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = Math.min(4, heading[1].length + 1)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i += 1
      continue
    }
    if (/^\s*\|/.test(line)) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++])
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim()))
      const body = rows.filter(row => !/^\s*\|?\s*:?-{2,}/.test(row))
      const [head, ...rest] = body
      out.push(
        '<table><thead><tr>' +
          cells(head).map(c => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' +
          rest.map(row => '<tr>' + cells(row).map(c => `<td>${c}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>',
      )
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${markdown(quote.join('\n'))}</blockquote>`)
      continue
    }
    const item = line.match(LIST_ITEM)
    if (item) {
      const ordered = /\d/.test(item[1])
      const items = []
      while (i < lines.length) {
        const next = lines[i].match(LIST_ITEM)
        if (next) {
          items.push(next[2])
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1] += ' ' + lines[i].trim()
        } else {
          break
        }
        i += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map(text => `<li>${inline(text)}</li>`).join('')}</${tag}>`)
      continue
    }
    const paragraph = []
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !(paragraph.length && BLOCK_START.test(lines[i]))) {
      paragraph.push(lines[i++])
    }
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
  }
  return out.join('')
}

const clock = at => new Date(at * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

function messageNode({ role, text, at }) {
  const node = document.createElement('article')
  node.className = `msg ${role}`
  const who = document.createElement('div')
  who.className = 'who'
  who.innerHTML = `<span>${role === 'user' ? 'ТЫ' : 'БРАТИИШКА'}</span><span>${escapeHtml(clock(at))}</span>`
  const body = document.createElement('div')
  body.className = 'body'
  if (role === 'user') body.textContent = text
  else body.innerHTML = markdown(text)
  node.append(who, body)
  return node
}

function appendMessage(message, scroll = true) {
  const log = $('log')
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120
  $('logEmpty').hidden = true
  log.append(messageNode(message))
  while (log.querySelectorAll('.msg').length > 60) log.querySelector('.msg').remove()
  if (scroll && nearBottom) log.scrollTop = log.scrollHeight
}

function renderHistory(history) {
  const log = $('log')
  log.querySelectorAll('.msg').forEach(node => node.remove())
  $('logEmpty').hidden = history.length > 0
  for (const message of history) appendMessage(message, false)
  log.scrollTop = log.scrollHeight
}

// ------------------------------------------------------------------ controls

function setLevel(level) {
  ui.level = level
  for (const button of document.querySelectorAll('[data-level]')) {
    button.setAttribute('aria-checked', String(button.dataset.level === level))
  }
}

function setPanel(open) {
  ui.panelOpen = open
  document.body.classList.toggle('panel-open', open)
  $('panelButton').setAttribute('aria-pressed', String(open))
  saved.set('robot.panel', open ? 'open' : 'closed')
}

function setMonitor(open) {
  ui.monitorOpen = open
  $('monitor').hidden = !open
  $('monitorButton').setAttribute('aria-pressed', String(open))
  saved.set('robot.monitor', open ? 'open' : 'closed')
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
  else document.documentElement.requestFullscreen().catch(() => undefined)
}

for (const button of document.querySelectorAll('[data-level]')) {
  button.addEventListener('click', () => {
    setLevel(button.dataset.level)
    post('/api/level', { level: button.dataset.level })
  })
}
$('stopButton').addEventListener('click', () => {
  stopAll()
  post('/api/stop')
})
$('panelButton').addEventListener('click', () => setPanel(!ui.panelOpen))
$('monitorButton').addEventListener('click', () => setMonitor(!ui.monitorOpen))
$('panelClose').addEventListener('click', () => setPanel(false))
$('fullButton').addEventListener('click', toggleFullscreen)

// ------------------------------------------------------------------ composer

const composer = $('composer')
const composerText = $('composerText')

const fitComposer = () => {
  composerText.style.height = 'auto'
  composerText.style.height = `${Math.min(180, composerText.scrollHeight)}px`
  $('composerSend').disabled = composerText.value.trim() === ''
}

async function sendPrompt() {
  const text = composerText.value.trim()
  if (!text) return
  composerText.value = ''
  fitComposer()
  const response = await post('/api/prompt', { text })
  if (!response || !response.ok) {
    composerText.value = text
    fitComposer()
    showNotice('Не отправилось: сервер робота не ответил', 5000)
  }
}

composer.addEventListener('submit', event => {
  event.preventDefault()
  void sendPrompt()
})
composerText.addEventListener('input', fitComposer)
composerText.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void sendPrompt()
  } else if (event.key === 'Escape') {
    composerText.blur()
  }
})
fitComposer()

// ------------------------------------------------------------------ voice

// Speech arrives as a paste: a dictation app (Handy: hold its key, speak,
// let go) pastes what was said into the window in front. Pasted while no
// text field has focus, it is a spoken prompt: the robot falls silent and
// the words go to Claude at once. A paste into the text field stays a paste.
async function sendSpoken(text) {
  stopAll()
  post('/api/stop')
  showNotice(`Ты: ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`, 4000)
  const response = await post('/api/prompt', { text })
  if (!response || !response.ok) showNotice('Не отправилось: сервер робота не ответил', 5000)
}

document.addEventListener('paste', event => {
  if (event.target instanceof HTMLElement && event.target.closest('textarea, input')) return
  const text = event.clipboardData?.getData('text/plain').trim()
  if (!text) return
  event.preventDefault()
  void sendSpoken(text)
})

window.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  // Typing a message: the letters are text, not shortcuts.
  if (event.target instanceof HTMLElement && event.target.closest('textarea, input')) return
  const key = event.key.toLowerCase()
  if (key === 't' || key === 'е') setPanel(!ui.panelOpen)
  else if (key === 'v' || key === 'м') setMonitor(!ui.monitorOpen)
  else if (key === 'f' || key === 'а') toggleFullscreen()
  else if (key === 'escape') {
    stopAll()
    post('/api/stop')
  }
})

// Show mode: a still mouse hides the controls while the text is folded.
let calmTimer = 0
const stir = () => {
  document.body.classList.remove('calm')
  clearTimeout(calmTimer)
  calmTimer = setTimeout(() => document.body.classList.add('calm'), 2600)
}
window.addEventListener('pointermove', stir)
window.addEventListener('pointerdown', stir)

// ------------------------------------------------------------------ events

function connect() {
  const events = new EventSource('/events')
  events.addEventListener('hello', e => {
    const data = JSON.parse(e.data)
    // The server was restarted, maybe with new files: take the new page.
    if (data.instance && data.instance !== INSTANCE) {
      location.reload()
      return
    }
    setLevel(data.level)
    ui.status = demo === 'think' ? 'thinking' : data.status
    renderHistory(data.history)
    monitor.load(data.actions)
    monitor.vitals(data.vitals)
  })
  events.addEventListener('action', e => takeAction(JSON.parse(e.data)))
  events.addEventListener('vitals', e => monitor.vitals(JSON.parse(e.data)))
  events.addEventListener('level', e => setLevel(JSON.parse(e.data).level))
  events.addEventListener('status', e => (ui.status = demo === 'think' ? 'thinking' : JSON.parse(e.data).status))
  events.addEventListener('message', e => appendMessage(JSON.parse(e.data)))
  events.addEventListener('part', e => enqueuePart(JSON.parse(e.data)))
  events.addEventListener('end', e => endJob(JSON.parse(e.data)))
  events.addEventListener('stop', () => stopAll())
  events.addEventListener('fail', e => showNotice(JSON.parse(e.data).message, 6000))
  events.addEventListener('replaced', () => {
    ui.replaced = true
    events.close()
    stopAll()
    showOverlay('РОБОТ В ДРУГОМ ОКНЕ', 'Открылось ещё одно окно робота, говорит теперь оно.', 'ВЕРНУТЬ СЮДА', () =>
      location.reload(),
    )
  })
  events.onopen = () => hideNotice()
  events.onerror = () => {
    if (!ui.replaced) showNotice('Нет связи с сервером робота, переподключаюсь…')
  }
}

// ------------------------------------------------------------------ frame loop

const motion = {
  level: 0,
  speak: 0,
  think: 0,
  listen: 0,
  flow: 0,
  onset: 1e9,
  offset: 1e9,
  talking: false,
  mic: 0,
  ear: 0,
  center: window.innerWidth / 2,
  free: window.innerWidth,
}
/** When the intro began, in performance.now() time; long ago when it is skipped. */
let introStart = skipIntro ? -1e9 : performance.now()
const introBuild = now => (now - introStart) / 1000 / INTRO_SECONDS

const talk = createTalk()
const life = createLife()
const monitor = createMonitor($('monitor'))
const status = createStatus({
  label: $('headLabel'),
  code: $('headCode'),
  caption: $('headCaption'),
  rain: $('headRain'),
  word: $('headWord'),
  glow: $('headGlow'),
  dot: $('headDot'),
  segments: [$('calloutA'), $('calloutB')],
  anchor: $('calloutAnchor'),
  small: $('statusText'),
  smallDot: $('statusDot'),
})
/** When a call last failed, in seconds: the monitor's trace goes red for a while. */
let failAt = -1e9
/** Where the demo's clock was on the last frame. */
let demoFrom = 0

function takeAction(call) {
  if (call.state === 'fail') failAt = Date.now() / 1000
  monitor.action(call)
}
const mic = createMic(
  () => audio.ctx,
  () => showNotice('Микрофон не дали: кольца не услышат твой голос', 5000),
)

/** What a demo mode makes up at `t` seconds: whether it speaks or thinks, and the person's voice. */
const demoAt = t => {
  if (demo === 'cycle') return demoCycle(t)
  if (demo === 'speak' || demo === 'loud') return { speaking: true, thinking: false, mic: 0 }
  if (demo === 'think') return { speaking: false, thinking: true, mic: 0 }
  if (demo === 'mic') return { speaking: false, thinking: false, mic: fakeVoice(t) }
  return null
}

const isSpeaking = () => demoAt(performance.now() / 1000)?.speaking ?? Boolean(speech.current)
const isThinking = () => demoAt(performance.now() / 1000)?.thinking ?? ui.status === 'thinking'

function listen(dt) {
  const time = performance.now() / 1000
  const fake = demoAt(time)
  const speaking = isSpeaking()
  let loud = 0
  if (demo === 'loud') {
    loud = 0.82 + 0.12 * Math.sin(time * 9)
  } else if (fake?.speaking) {
    loud = Math.min(1, Math.pow(Math.max(0, Math.sin(time * 7.3) * Math.sin(time * 2.1 + 1)), 0.5) * (0.55 + 0.45 * Math.sin(time * 0.7)) * 0.9)
  } else if (speaking && audio.analyser) {
    audio.analyser.getFloatTimeDomainData(audio.wave)
    let sum = 0
    for (const sample of audio.wave) sum += sample * sample
    loud = Math.min(1, Math.sqrt(sum / audio.wave.length) * 6.8)
  }
  const rate = loud > motion.level ? 0.45 : 0.09
  motion.level += (loud - motion.level) * Math.min(1, rate * dt * 60)
  motion.speak += ((speaking ? 1 : 0) - motion.speak) * Math.min(1, dt * (speaking ? 5 : 1.4))
  // Talking spans the pauses between its sentences: the flash and the ebb
  // come once per answer.
  const said = talk(time, speaking)
  motion.onset = said.onset
  motion.offset = said.offset
  motion.talking = said.talking
  if (demo === 'cycle') for (const call of demoCalls(demoFrom, time)) takeAction(call)
  demoFrom = time
  const thinking = isThinking() && !said.talking
  motion.think += ((thinking ? 1 : 0) - motion.think) * Math.min(1, dt * 2.5)
  // Listening: waiting for the person, the figure assembled and the mountains open.
  const listening = !said.talking && !thinking && introBuild(performance.now()) > 1.2
  motion.listen += ((listening ? 1 : 0) - motion.listen) * Math.min(1, dt * 1.5)
  const heard = fake ? fake.mic : mic.level()
  motion.mic += (heard - motion.mic) * Math.min(1, dt * (heard > motion.mic ? 18 : 4))
  motion.ear += dt * (1 + 5 * motion.mic * motion.listen)
  motion.flow += dt * (1 + 2.6 * motion.level * motion.speak)
}

let robot = null
let last = performance.now()
/**
 * The most frames a second it draws. A fast screen (the person's second one
 * runs at 180 Hz) would draw three times as many for the same look.
 */
const FRAME_MS = 1000 / 60

function tick(now) {
  if (now - last < FRAME_MS - 2) {
    requestAnimationFrame(tick)
    return
  }
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  listen(dt)
  const width = window.innerWidth
  const panelWidth = ui.panelOpen ? $('panel').getBoundingClientRect().width : 0
  // The monitor on the left takes its room too, when it shows at all.
  const shown = $('monitor').getBoundingClientRect()
  const monitorWidth = shown.width > 0 ? shown.right + 12 : 0
  const ease = Math.min(1, dt * 4.5)
  motion.center += (monitorWidth + (width - panelWidth - monitorWidth) / 2 - motion.center) * ease
  motion.free += (width - panelWidth - monitorWidth - motion.free) * ease
  const build = introBuild(now)
  const pose = life(now / 1000, dt, { think: motion.think, speak: motion.speak, level: motion.level })
  const state = monitorState({
    talking: motion.talking,
    thinking: isThinking(),
    actions: monitor.actions(),
    failAt,
    now: Date.now() / 1000,
  })
  // The monitor keeps the heartbeat: the heart in the chest beats with it.
  const vital = monitor.frame(dt, { state, level: motion.level, mic: motion.mic * motion.listen })
  const { sinceBeat } = vital
  const view = robot.frame({
    time: now / 1000,
    flow: motion.flow,
    level: motion.level,
    speak: motion.speak,
    think: motion.think,
    listen: motion.listen,
    build,
    centerPx: motion.center,
    freePx: motion.free,
    head: pose.head,
    sway: pose.sway,
    onset: motion.onset,
    offset: motion.offset,
    mic: motion.mic * motion.listen,
    ear: motion.ear,
    sinceBeat,
  })
  followSubtitle()
  // The status beside the head, its line to the temple, beating with the heart.
  status.show(
    build < 1 ? assembling(build) : WORDS[state],
    state,
    Math.exp(-sinceBeat * 5),
    robot.toScreen(0.4, 0.5, view.shift, view.zoom),
    robot.toScreen(0.205, 0.43, view.shift, view.zoom),
    { ...vital, mic: motion.mic * motion.listen, level: motion.level * motion.speak },
  )
  requestAnimationFrame(tick)
}

function start() {
  setPanel(ui.panelOpen)
  setMonitor(ui.monitorOpen)
  if (demo) monitor.vitals(DEMO_VITALS)
  setLevel(ui.level)
  try {
    robot = createRobot($('stage'))
  } catch (error) {
    showOverlay('ГРАФИКА НЕ ЗАВЕЛАСЬ', String(error && error.message ? error.message : error), 'ПЕРЕЗАГРУЗИТЬ', () =>
      location.reload(),
    )
    return
  }
  setupAudio()
  // The microphone is open only while the window is in front, so the rings
  // hear the person speaking to it and nobody else.
  if (!demo) {
    window.addEventListener('focus', () => void mic.open())
    window.addEventListener('blur', () => mic.close())
    if (document.hasFocus()) void mic.open()
  }
  // The scene was built in createRobot: the intro starts now, with its sound.
  if (!skipIntro) introStart = performance.now()
  introSound()
  greetSoon()
  connect()
  stir()
  requestAnimationFrame(tick)
}

start()
