import type { EngineInterface, Register } from 'claude-code'

import { MAX_TOKENS, SPEECH_SYSTEM, cleanForSpeech, fallbackSpeech, isLevel, pieces, speechPrompt } from './speech'
import type { Level } from './speech'
import { kindOf } from './calls'
import { PERSONA, PERSONA_ID } from './persona'
import { SCREENS_SCRIPT, parseScreens, secondScreen } from './screens'
import { createVoice } from './voice'
import type { Heard, Voice } from './voice'

// The robot lives in a window of its own, served by runtime/server.py. The
// mod starts that server and the window on /robot, and from then on hands the
// window each prompt, each answer and the words to say, and brings what the
// person types or says in the window into the session as their own prompt.
// The window's monitor gets each tool call as it starts and ends, and the
// session's figures (context, rate limits, cost) whenever the engine measures.
//
// While this session's robot window is open, the model answers in the robot's
// manner: the mod adds a section of its own to every system prompt it sends.
//
// An answer read whole is said while it is still being written: its text is
// taken off the model's stream sentence by sentence. A shorter level retells
// the whole answer, so it waits for the answer's end.
//
// The window belongs to the session that ran /robot last: every session with
// the mod loaded polls the same server, so only the owner takes the window's
// prompts and only the owner's turns reach the window. The server holds the
// owner and checks it (the X-Robot-Session header, the inbox's session).

const ROBOT = 'http://127.0.0.1:47219'
const DESCRIPTION = 'Открыть робота-собеседника в отдельном окне'
/**
 * /robot as a command file of the person's own: a new session lists those
 * before any hook of a mod has run, which a command registered at
 * `session.start` is not. A run of it reaches the `command.run` hook all the
 * same; its text goes to the model only where the mod is not loaded.
 */
const COMMAND_FILE = '.claude/commands/robot.md'
const COMMAND_TEXT = [
  '---',
  `description: ${DESCRIPTION}`,
  '---',
  'Мод робота в этой сессии не загружен, поэтому команда /robot ничего не открыла.',
  'Скажи пользователю одной короткой фразой, что мод робота подключается при старте сессии',
  'и нужно открыть новую сессию. Больше ничего не делай.',
  '',
].join('\n')
const USER_TEXT_LIMIT = 6000
const INBOX_POLL_MS = 1000
/** How much of a call's subject the monitor's feed shows. */
const DETAIL_LIMIT = 70

/** The server's token, read from its file, and whether a relay is under way. */
type Inbox = { token?: string; isBusy: boolean }

/** The window's state; `owner` the session it belongs to, null while it belongs to none. */
type RobotState = { listeners: number; level: Level; owner: string | null }

const robotState = async ($: EngineInterface): Promise<RobotState | undefined> => {
  try {
    const response = await $.http.fetch(`${ROBOT}/api/state`)
    if (!response.ok) return undefined
    const data = JSON.parse(response.text) as { listeners?: unknown; level?: unknown; owner?: unknown }

    return {
      listeners: typeof data.listeners === 'number' ? data.listeners : 0,
      level: isLevel(data.level) ? data.level : 'mid',
      owner: typeof data.owner === 'string' ? data.owner : null,
    }
  } catch {
    return undefined
  }
}

/** The window's state when this session may drive it: running, and its owner or no one's. */
const ownState = async ($: EngineInterface): Promise<RobotState | undefined> => {
  const state = await robotState($)
  if (!state) return undefined
  if (state.owner !== null && state.owner !== (await $.session.id())) return undefined

  return state
}

/** Whether the window is open and this session's own: the robot listens to this session. */
const isListening = async ($: EngineInterface): Promise<boolean> => {
  const state = await robotState($)

  return state !== undefined && state.listeners > 0 && state.owner === (await $.session.id())
}

const tell = async ($: EngineInterface, path: string, body: object): Promise<boolean> => {
  try {
    const response = await $.http.fetch(`${ROBOT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Robot-Session': await $.session.id() },
      body: JSON.stringify(body),
    })

    return response.ok
  } catch {
    return false
  }
}

/**
 * Hands words to the window's voice as part of a turn's answer: 'muted' once
 * the person silenced that answer, 'gone' when no window takes it.
 */
const speak = async ($: EngineInterface, text: string, turn: string): Promise<Heard> => {
  try {
    const response = await $.http.fetch(`${ROBOT}/api/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Robot-Session': await $.session.id() },
      body: JSON.stringify({ text, turn }),
    })
    if (!response.ok) return 'gone'
    const data = JSON.parse(response.text || '{}') as { muted?: unknown }

    return data.muted === true ? 'muted' : 'said'
  } catch {
    return 'gone'
  }
}

const readToken = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const text = String(await $.fs.read(`${$.plugin.root}/runtime/.token`)).trim()

    return text || undefined
  } catch {
    return undefined
  }
}

/** Submits the prompts typed or spoken in the robot window, each as the person's own; the owner's only. */
const relayInbox = async ($: EngineInterface, inbox: Inbox): Promise<void> => {
  inbox.token ??= await readToken($)
  if (!inbox.token) return
  const session = encodeURIComponent(await $.session.id())
  let response
  try {
    response = await $.http.fetch(`${ROBOT}/api/inbox?session=${session}`, { headers: { 'X-Robot-Token': inbox.token } })
  } catch {
    return
  }
  // A restarted server wrote a new token: read it on the next round.
  if (response.status === 401) inbox.token = undefined
  if (!response.ok) return
  const data = JSON.parse(response.text) as { prompts?: unknown }
  const prompts = Array.isArray(data.prompts) ? data.prompts : []
  for (const text of prompts) {
    if (typeof text === 'string' && text.trim()) await $.prompt.submit({ text, asUser: true })
  }
}

/** Starts runtime/server.py under the Silero venv's Python, detached. */
const startServer = async ($: EngineInterface): Promise<boolean> => {
  const runtime = `${$.plugin.root}/runtime`
  await $.process.run([
    '/bin/sh',
    '-c',
    'py="$HOME/.claude/mods/silero-tts/venv/bin/python"; [ -x "$py" ] || py=python3; ' +
      'nohup "$py" "$0" >>"$1" 2>&1 </dev/null &',
    `${runtime}/server.py`,
    `${runtime}/server.log`,
  ])
  for (let attempt = 0; attempt < 30; attempt++) {
    await $.clock.sleep(200)
    if (await robotState($)) return true
  }

  return false
}

/**
 * Whether /robot was in the person's command files as this session began;
 * written there when missing, so the next session lists it from the start.
 */
const isCommandListed = async ($: EngineInterface): Promise<boolean> => {
  try {
    const home = await $.env.get('HOME')
    if (!home) return false
    const path = `${home}/${COMMAND_FILE}`
    if (await $.fs.exists(path)) return true
    await $.fs.write(path, COMMAND_TEXT)
  } catch (error) {
    $.ui.log(`robot: could not write the command file: ${String(error)}`)
  }

  return false
}

/** Makes the window this session's: its prompts come here, this session's answers go there. */
const claim = async ($: EngineInterface): Promise<boolean> => {
  const token = await readToken($)
  if (!token) return false
  try {
    const response = await $.http.fetch(`${ROBOT}/api/owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Robot-Token': token },
      body: JSON.stringify({ owner: await $.session.id() }),
    })

    return response.ok
  } catch {
    return false
  }
}

/** Where the window goes: filling the second screen; at Chrome's default place, sized, without one. */
const windowPlace = async ($: EngineInterface): Promise<string[]> => {
  try {
    const listed = await $.process.run(['osascript', '-l', 'JavaScript', '-e', SCREENS_SCRIPT])
    const place = listed.exitCode === 0 ? secondScreen(parseScreens(listed.stdout.trim())) : undefined
    if (place) return [`--window-position=${place.x},${place.y}`, `--window-size=${place.width},${place.height}`]
  } catch (error) {
    $.ui.log(`robot: could not find the screens: ${String(error)}`)
  }

  return ['--window-size=1600,1000']
}

/** Opens the robot in a Chrome app window of its own profile, sound allowed, on the second screen if there is one. */
const openWindow = async ($: EngineInterface) =>
  $.process.run([
    'open',
    '-na',
    'Google Chrome',
    '--args',
    `--user-data-dir=${$.plugin.root}/runtime/.chrome-profile`,
    `--app=${ROBOT}/`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    ...(await windowPlace($)),
  ])

/** A stripped text retold for the voice at this level; the text cut to length if the model fails. */
const retell = async ($: EngineInterface, plain: string, level: Level): Promise<string> => {
  const reply = await $.model.complete({
    model: 'haiku',
    system: SPEECH_SYSTEM,
    prompt: speechPrompt(plain, level),
    maxTokens: MAX_TOKENS[level],
    timeoutMs: 30000,
  })
  if (reply.isAnswered && reply.text.trim()) return reply.text.trim()
  $.ui.log(`robot: the retelling failed (${reply.isAnswered ? 'empty' : reply.reason}), reading the text as is`)

  return fallbackSpeech(plain, level)
}

/**
 * Says an answer at this level. A whole answer is retold piece by piece, all
 * pieces at once, and each is said as soon as it and those before it are ready.
 */
const sayAnswer = async ($: EngineInterface, answer: string, level: Level, turn: string): Promise<void> => {
  const plain = cleanForSpeech(answer)
  if (!plain) return
  const parts = level === 'full' ? pieces(plain) : [plain]
  const retold = parts.map(part => retell($, part, level))
  for (const words of retold) {
    const text = await words
    if (text && (await speak($, text, turn)) !== 'said') return
  }
}

/**
 * A turn said as it is written: its voice, and whether it speaks at all
 * (this session's window, open, reading answers whole).
 */
type Streamed = { voice: Voice; isOn: Promise<boolean> }

const streamTurn = ($: EngineInterface, turn: string): Streamed => {
  const isOn = ownState($).then(state => state !== undefined && state.listeners > 0 && state.level === 'full')
  const voice = createVoice(
    async plain => ((await isOn) ? retell($, plain, 'full') : ''),
    async text => ((await isOn) ? speak($, text, turn) : 'gone'),
  )

  return { voice, isOn }
}

/**
 * Hands a finished answer to the window: the text to show and, unless it was
 * said while it was written, the words to say.
 */
const deliver = async (
  $: EngineInterface,
  answer: string,
  isAnswer: boolean,
  turn: string,
  streamed: Streamed | undefined,
): Promise<void> => {
  const state = await ownState($)
  if (!state) return
  await tell($, '/api/status', { status: 'idle' })
  if (!isAnswer || !answer.trim()) return
  await tell($, '/api/message', { role: 'assistant', text: answer })
  if (state.listeners === 0) return
  if (streamed && (await streamed.isOn)) return
  await sayAnswer($, answer, state.level, turn)
}

/**
 * What a tool call is about, for the monitor's feed: a file's name, a
 * command's own description before the command itself (a command may carry
 * a secret), a pattern, a query, an address.
 */
const detailOf = (input: Record<string, unknown>): string => {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const path = text('file_path') || text('notebook_path')
  const raw = path
    ? (path.split('/').pop() ?? '')
    : text('description') || text('command') || text('pattern') || text('query') || text('url') || text('skill')
  const flat = raw.replace(/\s+/g, ' ').trim()

  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT)}…` : flat
}

/** When a rate limit resets, in Unix seconds; null when unknown. */
const resetsOf = (at: string | undefined): number | null => {
  const ms = at ? Date.parse(at) : Number.NaN

  return Number.isFinite(ms) ? ms / 1000 : null
}

/**
 * The session's figures for the monitor: how full the context is (in percent
 * and in tokens of its window), the rate limits and when they reset, the
 * cost, how long the session has run and its model.
 */
const sendVitals = async ($: EngineInterface): Promise<void> => {
  const usage = await $.session.usage()
  await tell($, '/api/vitals', {
    context: usage.context.percent ?? null,
    tokens: usage.context.tokens ?? null,
    window: usage.context.window,
    limits: usage.rateLimits.map(one => ({ kind: one.kind, used: one.percentUsed, resets: resetsOf(one.resetsAt) })),
    usd: usage.cost?.usd ?? null,
    ageMs: Math.max(0, (await $.clock.now()) - usage.startedAt),
    model: await $.session.model(),
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Listed twice otherwise: the file's /robot and the registered one.
    if (!(await isCommandListed($))) await $.command.register({ name: 'robot', description: DESCRIPTION })
    const inbox: Inbox = { isBusy: false }
    $.clock.every(INBOX_POLL_MS, () => {
      if (inbox.isBusy) return
      inbox.isBusy = true
      void relayInbox($, inbox)
        .catch(error => $.ui.log(`robot: could not take the window's prompts: ${String(error)}`))
        .finally(() => (inbox.isBusy = false))
    })

    return next(e)
  })

  on('command.run', { command: 'robot' }, async $ => {
    const isUp = (await robotState($)) !== undefined || (await startServer($))
    if (!isUp) {
      return {
        text: `Сервер робота не поднялся. Лог: ${$.plugin.root}/runtime/server.log`,
      }
    }
    if (!(await claim($))) {
      return { text: 'Робот не стал слушать эту сессию: сервер не принял её. Перезапусти /robot.' }
    }
    void sendVitals($).catch(error => $.ui.log(`robot: could not send the figures: ${String(error)}`))
    const opened = await openWindow($)
    if (opened.exitCode !== 0) {
      return { text: `Окно не открылось (нужен Google Chrome). Робот доступен по адресу ${ROBOT}/` }
    }

    return {
      text:
        'Робот открыт в отдельном окне и слушает эту сессию. ' +
        'Говорить с ним можно голосом через Handy, пока окно активно. ' +
        'T сворачивает окно с текстом, F разворачивает во весь экран, Esc заставляет замолчать.',
    }
  })

  // Every prompt the engine sends is composed anew, so the manner comes and
  // goes with the window; a robot that does not answer leaves the prompt be.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await isListening($))) return composed

    return {
      sections: [
        ...composed.sections.filter(section => section.id !== PERSONA_ID),
        { id: PERSONA_ID, text: PERSONA, scope: 'session' as const },
      ],
    }
  })

  on('turn.start', async ($, e, next) => {
    // Fire and forget: a missing robot must not hold the turn up.
    void ownState($).then(state => {
      if (!state) return
      const text = e.text.length > USER_TEXT_LIMIT ? `${e.text.slice(0, USER_TEXT_LIMIT)}…` : e.text
      if (text.trim()) void tell($, '/api/message', { role: 'user', text })
      void tell($, '/api/status', { status: 'thinking' })
    })

    return next(e)
  })

  // The monitor's feed: each call as it starts and as it ends, and whether it
  // runs tests (the window glitches harder when they fail). Fire and forget,
  // so a missing robot never holds a call up; should the hook fail, the call
  // goes on as if it were not here.
  let calls = 0
  on('tool.call', async ($, e, next) => {
    calls += 1
    const id = e.tool_use_id || `call-${calls}`
    const input = e as unknown as Record<string, unknown>
    const action = { id, tool: e.tool, detail: detailOf(input), kind: kindOf(e.tool, input), sub: e.agentId !== undefined }
    const report = (state: string) => void tell($, '/api/action', { ...action, state }).catch(() => undefined)
    report('run')
    const ran = await next(e)
    report(ran.deny !== undefined || ran.isError === true ? 'fail' : 'ok')

    return ran
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    void sendVitals($).catch(error => $.ui.log(`robot: could not send the figures: ${String(error)}`))

    return result
  })

  // The main loop's text, said as it streams. The voice is fed off to the
  // side: the stream is never held up and a fault in it never reaches it.
  const streamed = new Map<string, Streamed>()
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const turn = streamed.get(e.turnId) ?? streamTurn($, e.turnId)
    streamed.set(e.turnId, turn)
    const feed = (act: (voice: Voice) => void) => {
      try {
        act(turn.voice)
      } catch (error) {
        $.ui.log(`robot: could not say the text as it came: ${String(error)}`)
      }
    }
    const stream = next(e)
    let block: number | undefined
    let piece = await stream.next()
    while (!piece.done) {
      const chunk = piece.value
      if (chunk.kind === 'text') {
        if (block !== undefined && block !== chunk.index) feed(voice => voice.end())
        block = chunk.index
        feed(voice => voice.write(chunk.text))
      } else if (chunk.kind === 'tool') {
        feed(voice => voice.end())
      }
      yield chunk
      piece = await stream.next()
    }
    // An interrupted answer leaves its last half-sentence unsaid.
    feed(voice => (next.signal.aborted ? undefined : voice.end()))

    return piece.value
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const turn = streamed.get(e.turnId)
    streamed.delete(e.turnId)
    if (e.agentId === undefined) {
      if (e.isAborted) turn?.voice.hush()
      void deliver($, e.answer, e.reason === 'answer', e.turnId, turn).catch(error =>
        $.ui.log(`robot: could not hand the answer over: ${String(error)}`),
      )
    }

    return result
  })
}
