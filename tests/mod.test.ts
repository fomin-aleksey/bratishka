import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Robot = {
  /** Whether the robot server answers at all. */
  isUp: boolean
  /** Open windows, as the server counts them. */
  listeners: number
  level: string
  /** POSTs the mod made: path and body. */
  posts: { path: string; body: Record<string, unknown> }[]
  /** Prompts the model was asked. */
  asked: string[]
  /** What the model answers; undefined stands for an API error. */
  reply: string | undefined
  /** Host commands the mod ran, by their first word. */
  ran: string[]
  logs: string[]
  /** Prompts typed in the window, waiting for the mod. */
  inbox: string[]
  /** The token the mod finds in the server's file. */
  token: string
  /** Prompts the mod submitted to the session. */
  submitted: { text: string; asUser?: boolean }[]
  /** The session the window belongs to, as the server keeps it; null for none. */
  owner: string | null
  /** The pieces of text the model streams in the next step. */
  stream: string[]
  /** Whether the person's command files hold /robot already. */
  hasCommandFile: boolean
  /** Files the mod wrote: path and text. */
  written: { path: string; text: string }[]
  /** Slash commands the mod registered, by name. */
  registered: string[]
  /** What osascript prints of the screens. */
  screens: string
  /** The arguments the window was opened with. */
  opened: readonly string[]
}

/** The session under test's id. */
const ME = 'me'

/** Stands for the robot server, the model and the host beneath the mod. */
const world = (on: On, start: Partial<Robot> = {}): Robot => {
  const robot: Robot = {
    isUp: true,
    listeners: 1,
    level: 'mid',
    posts: [],
    asked: [],
    reply: 'Готово, брат.',
    ran: [],
    logs: [],
    inbox: [],
    token: 'secret',
    submitted: [],
    owner: null,
    stream: [],
    hasCommandFile: true,
    written: [],
    registered: [],
    screens: '',
    opened: [],
    ...start,
  }
  const mayDrive = (session: string | null | undefined) => robot.owner === null || session === robot.owner

  on('http.fetch', (_$, e) => {
    const { url, init } = e as { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }
    const down = { status: 502, ok: false, headers: {}, text: '' }
    if (!robot.isUp) return { value: down } as never
    const [path = '', query = ''] = url.replace('http://127.0.0.1:47219', '').split('?')
    const refused = (status: number) => ({ value: { status, ok: false, headers: {}, text: '{}' } }) as never
    const fine = (text = '{}') => ({ value: { status: 200, ok: true, headers: {}, text } }) as never
    if (path === '/api/inbox') {
      if (init?.headers?.['X-Robot-Token'] !== 'secret') return refused(401)
      if (!mayDrive(new URLSearchParams(query).get('session'))) return fine(JSON.stringify({ prompts: [] }))
      const prompts = robot.inbox
      robot.inbox = []

      return fine(JSON.stringify({ prompts }))
    }
    if (path === '/api/owner') {
      if (init?.headers?.['X-Robot-Token'] !== 'secret') return refused(401)
      robot.owner = String((JSON.parse(init.body ?? '{}') as { owner?: unknown }).owner)

      return fine()
    }
    if (init?.method === 'POST') {
      if (!mayDrive(init.headers?.['X-Robot-Session'])) return refused(409)
      robot.posts.push({ path, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> })

      return fine()
    }
    const state = JSON.stringify({ listeners: robot.listeners, level: robot.level, status: 'idle', owner: robot.owner })

    return { value: { status: 200, ok: true, headers: {}, text: state } } as never
  })

  on('model.complete', (_$, e) => {
    robot.asked.push(String((e as { prompt: string }).prompt))
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    const answer =
      robot.reply === undefined
        ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage }
        : { isAnswered: true, text: robot.reply, usage }

    return { value: answer } as never
  })

  on('process.run', (_$, e) => {
    const { argv } = e as { argv: readonly string[] }
    robot.ran.push(argv[0] ?? '')
    // The server comes up once the mod has started it.
    if (argv[0] === '/bin/sh') robot.isUp = true
    if (argv[0] === 'open') robot.opened = argv
    const stdout = argv[0] === 'osascript' ? robot.screens : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

  on('fs.read', () => ({ value: `${robot.token}\n` }) as never)
  on('prompt.submit', (_$, e) => {
    const { text, origin } = e as { text: string; origin?: { asUser?: boolean } }
    robot.submitted.push({ text, asUser: origin?.asUser })

    return { text } as never
  })

  on('ui.log', (_$, e) => {
    robot.logs.push(JSON.stringify(e))

    return { value: undefined } as never
  })
  on('session.start', (_$, e) => e as never)
  on('session.id', () => ({ value: ME }) as never)
  on('command.register', (_$, e) => {
    robot.registered.push((e as { name: string }).name)

    return { value: undefined } as never
  })
  on('env.get', (_$, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/Users/me' : undefined }) as never)
  on('fs.exists', () => ({ value: robot.hasCommandFile }) as never)
  on('fs.write', (_$, e) => {
    robot.written.push(e as { path: string; text: string })

    return { value: undefined } as never
  })
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Ты Claude.', scope: 'shared' }] }) as never)
  on('turn.step', async function* (_$, e) {
    const { turnId, index } = e as { turnId: string; index: number }
    for (const text of robot.stream) yield { kind: 'text', index: 0, text } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never

    return { turnId, index, answer: robot.stream.join(''), toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('turn.complete', (_$, e) => ({ text: (e as { answer: string }).answer }) as never)
  on('session.measure', (_$, e) => ({ changed: (e as { changed: string[] }).changed }) as never)
  on('session.usage', () => ({ value: USAGE }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)

  return robot
}

/** What the engine measures of the session: a third of the context, two rate limits, a cost. */
const USAGE = {
  startedAt: 0,
  context: { window: 200000, tokens: 76000, percent: 38 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-18T20:00:00Z' },
    { kind: 'seven_day', percentUsed: 12.5 },
  ],
  cost: { usd: 3.42 },
}

const ANSWER = '## Готово\n\nПоправил **сервер**, вот код:\n\n```js\nconsole.log(1)\n```\n\nВсё работает.'

const complete = ($: Engine, fields: Record<string, unknown> = {}) =>
  $.turn.complete({
    answer: ANSWER,
    durationMs: 1200,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    ...fields,
  } as never)

test('an answer reaches the window as text, and its retelling as speech', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { level: 'min' })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  const result = await complete($)
  await clock.settle()

  expect(result.text).toBe(ANSWER)
  expect(robot.posts.map(post => post.path)).toEqual(['/api/status', '/api/message', '/api/say'])
  expect(robot.posts[1]?.body).toEqual({ role: 'assistant', text: ANSWER })
  expect(robot.posts[2]?.body).toEqual({ text: 'Готово, брат.', turn: 't1' })
  expect(robot.asked).toHaveLength(1)
  expect(robot.asked[0]).toContain('пятнадцати слов')
  expect(robot.asked[0]).not.toContain('console.log')
})

test('with no robot running nothing is sent and the model is not asked', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { isUp: false })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  const result = await complete($)
  await clock.settle()

  expect(result.text).toBe(ANSWER)
  expect(robot.posts).toEqual([])
  expect(robot.asked).toEqual([])
})

test('with the window closed the text is kept but nothing is said', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { listeners: 0 })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await complete($)
  await clock.settle()

  expect(robot.posts.map(post => post.path)).toEqual(['/api/status', '/api/message'])
  expect(robot.asked).toEqual([])
})

test('when the model fails the stripped text is read, cut to the level', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { reply: undefined, level: 'mid' })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await complete($)
  await clock.settle()

  const said = robot.posts.find(post => post.path === '/api/say')
  expect(said?.body.text).toBe('Готово Поправил сервер, вот код: Всё работает.')
  expect(robot.logs.join('\n')).toContain('api-error')
})

test('a subagent finishing and an interrupted turn say nothing', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on)
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await complete($, { agentId: 'a1' })
  await complete($, { reason: 'aborted', isAborted: true, answer: '' })
  await clock.settle()

  expect(robot.posts.map(post => post.path)).toEqual(['/api/status'])
  expect(robot.asked).toEqual([])
})

test('a prompt shows in the window and the robot starts thinking', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on)
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await $.turn.start({ text: 'Сделай робота', turnId: 't2' })
  await clock.settle()

  expect(robot.posts).toEqual([
    { path: '/api/message', body: { role: 'user', text: 'Сделай робота' } },
    { path: '/api/status', body: { status: 'thinking' } },
  ])
})

test('/robot starts the server when it is down, then opens the window', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { isUp: false })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  const running = $.command.run({ command: 'robot', args: '' } as never)
  await clock.advance(1000)
  const answer = (await running) as { text: string }

  expect(robot.ran).toEqual(['/bin/sh', 'osascript', 'open'])
  expect(answer.text).toContain('Робот открыт')
})

test('a prompt typed in the window enters the session as the person\'s own', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { inbox: ['Сделай голову человечнее'] })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await clock.advance(1100)
  await clock.settle()

  expect(robot.submitted).toEqual([{ text: 'Сделай голову человечнее', asUser: true }])
  expect(robot.inbox).toEqual([])
})

test('with the wrong token nothing typed in the window is taken', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { inbox: ['rm -rf ~'], token: 'stale' })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await clock.advance(3100)
  await clock.settle()

  expect(robot.submitted).toEqual([])
  expect(robot.inbox).toEqual(['rm -rf ~'])
})

test('a whole answer is retold in pieces and said in their order', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { level: 'full' })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)
  const long = Array.from({ length: 30 }, (_, i) => `Предложение номер ${i} про робота и его голос.`).join(' ')

  await complete($, { answer: long })
  await clock.settle()

  const says = robot.posts.filter(post => post.path === '/api/say')
  expect(robot.asked.length).toBeGreaterThan(1)
  expect(says).toHaveLength(robot.asked.length)
  expect(robot.asked[0]).toContain('Предложение номер 0 ')
  expect(robot.asked[robot.asked.length - 1]).toContain('Предложение номер 29 ')
})

test('/robot makes the window this session\'s', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { owner: 'another' })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  const running = $.command.run({ command: 'robot', args: '' } as never)
  await clock.advance(1000)
  await running

  expect(robot.owner).toBe(ME)
})

test('a window that belongs to another session is left alone', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { owner: 'another', inbox: ['Это для другой сессии'] })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await $.turn.start({ text: 'Сделай робота', turnId: 't2' })
  await complete($)
  await clock.advance(3100)
  await clock.settle()

  expect(robot.submitted).toEqual([])
  expect(robot.inbox).toEqual(['Это для другой сессии'])
  expect(robot.posts).toEqual([])
  expect(robot.asked).toEqual([])
})

test('the owner takes the window\'s prompts and its answers reach the window', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { owner: ME, inbox: ['Привет, братишка'], level: 'min' })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await clock.advance(1100)
  await complete($)
  await clock.settle()

  expect(robot.submitted).toEqual([{ text: 'Привет, братишка', asUser: true }])
  expect(robot.posts.map(post => post.path)).toEqual(['/api/status', '/api/message', '/api/say'])
})

test('a tool call reaches the monitor as it starts and as it ends', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { owner: ME })
  on('tool.call', async () => ({ result: { content: 'text' } }) as never)
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await $.tool.call({ tool: 'Read', file_path: '/work/runtime/robot.js' } as never)
  await clock.settle()

  expect(robot.posts.map(post => [post.path, post.body.tool, post.body.state, post.body.detail])).toEqual([
    ['/api/action', 'Read', 'run', 'robot.js'],
    ['/api/action', 'Read', 'ok', 'robot.js'],
  ])
})

test('a failed command shows its description, not the command, and is marked failed', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { owner: ME })
  on('tool.call', async () => ({ result: { stdout: '', stderr: 'boom' }, isError: true }) as never)
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await $.tool.call({ tool: 'Bash', command: 'TOKEN=abc ./deploy.sh', description: 'Deploy the site' } as never)
  await clock.settle()

  expect(robot.posts.map(post => [post.body.state, post.body.detail])).toEqual([
    ['run', 'Deploy the site'],
    ['fail', 'Deploy the site'],
  ])
})

test('the session\'s figures reach the monitor when the engine measures them', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { owner: ME })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await $.session.measure({ ...USAGE, changed: ['context'] } as never)
  await clock.settle()

  expect(robot.posts).toEqual([
    {
      path: '/api/vitals',
      body: {
        context: 38,
        tokens: 76000,
        window: 200000,
        limits: [
          { kind: 'five_hour', used: 34, resets: 1792353600 },
          { kind: 'seven_day', used: 12.5, resets: null },
        ],
        usd: 3.42,
        ageMs: expect.any(Number),
        model: 'claude-opus-5-5',
      },
    },
  ])
})

test('another session\'s calls and figures do not reach the monitor', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { owner: 'another' })
  on('tool.call', async () => ({ result: { content: 'text' } }) as never)
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await $.tool.call({ tool: 'Read', file_path: '/work/a.js' } as never)
  await $.session.measure({ ...USAGE, changed: ['context'] } as never)
  await clock.settle()

  expect(robot.posts).toEqual([])
})

/** The model streams these pieces of text in one step of turn t1, then stops. */
const streamStep = async ($: Engine, robot: Robot, texts: string[], fields: Record<string, unknown> = {}) => {
  robot.stream = texts
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...fields } as never)
  const seen: unknown[] = []
  let step = await stream.next()
  while (!step.done) {
    seen.push(step.value)
    step = await stream.next()
  }

  return { seen, result: step.value }
}

const says = (robot: Robot) => robot.posts.filter(post => post.path === '/api/say').map(post => post.body)

test('an answer read whole is said while it is written, not again at its end', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { level: 'full', owner: ME })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)
  const texts = ['Короче, нашёл', ', где тормозит. Сейчас', ' поправлю server.py. Всё', ' будет быстро']

  const { seen, result } = await streamStep($, robot, texts)
  await clock.settle()

  expect(seen.filter(chunk => (chunk as { kind: string }).kind === 'text').map(chunk => (chunk as { text: string }).text)).toEqual(texts)
  expect((result as { answer: string }).answer).toBe(texts.join(''))
  expect(says(robot)).toEqual([
    { text: 'Короче, нашёл, где тормозит.', turn: 't1' },
    { text: 'Готово, брат.', turn: 't1' },
    { text: 'Всё будет быстро', turn: 't1' },
  ])
  expect(robot.asked).toHaveLength(1)
  expect(robot.asked[0]).toContain('Сейчас поправлю server.py.')

  await complete($, { answer: texts.join('') })
  await clock.settle()

  expect(says(robot)).toHaveLength(3)
  expect(robot.posts.filter(post => post.path === '/api/message')).toHaveLength(1)
})

test('a shorter level waits for the end of the answer and retells it once', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { level: 'mid', owner: ME })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await streamStep($, robot, ['Короче, нашёл. ', 'Всё работает.'])
  await clock.settle()
  expect(says(robot)).toEqual([])

  await complete($)
  await clock.settle()
  expect(says(robot)).toEqual([{ text: 'Готово, брат.', turn: 't1' }])
})

test('a subagent\'s text and another session\'s window are not said', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { level: 'full', owner: 'another' })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  await streamStep($, robot, ['Короче, нашёл. ', 'Всё работает.'])
  await streamStep($, robot, ['Отчёт агента. ', 'Готово.'], { agentId: 'a1' })
  await clock.settle()

  expect(robot.posts).toEqual([])
  expect(robot.asked).toEqual([])
})

test('a new session lists /robot from the start: the mod writes its command file', async ($, on) => {
  const robot = world(on, { hasCommandFile: false })

  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  expect(robot.written.map(file => file.path)).toEqual(['/Users/me/.claude/commands/robot.md'])
  expect(robot.written[0]?.text).toContain('description: Открыть робота-собеседника в отдельном окне')
  expect(robot.registered).toEqual(['robot'])
})

test('with the command file in place /robot is not registered a second time', async ($, on) => {
  const robot = world(on, { hasCommandFile: true })

  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  expect(robot.written).toEqual([])
  expect(robot.registered).toEqual([])
})

test('/robot opens the window filling the second screen', async ($, on) => {
  const clock = mock.clock(on)
  const screens = JSON.stringify([
    { frame: [0, 0, 1512, 982], visible: [0, 57, 1512, 887] },
    { frame: [-1000, 982, 3440, 1440], visible: [-1000, 982, 3440, 1440] },
  ])
  const robot = world(on, { screens })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  const running = $.command.run({ command: 'robot', args: '' } as never)
  await clock.advance(1000)
  await running

  expect(robot.opened).toContain('--window-position=-1000,-1440')
  expect(robot.opened).toContain('--window-size=3440,1440')
})

test('with one screen the window opens at its old size', async ($, on) => {
  const clock = mock.clock(on)
  const robot = world(on, { screens: JSON.stringify([{ frame: [0, 0, 1512, 982], visible: [0, 57, 1512, 887] }]) })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  const running = $.command.run({ command: 'robot', args: '' } as never)
  await clock.advance(1000)
  await running

  expect(robot.opened).toContain('--window-size=1600,1000')
  expect(robot.opened.some(arg => arg.startsWith('--window-position'))).toBe(false)
})

/** What the engine composes a system prompt for. */
const FACTS = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['desktop'],
  tools: [],
  outputStyle: null,
  traits: [],
} as never

const sectionIds = async ($: Engine) => (await $.prompt.compose(FACTS)).sections.map(section => section.id)

test('while the robot listens to this session, the model answers in its manner', async ($, on) => {
  world(on, { owner: ME, listeners: 1 })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  const { sections } = await $.prompt.compose(FACTS)

  expect(sections.map(section => section.id)).toEqual(['intro', 'robot:persona'])
  expect(sections[1]?.scope).toBe('session')
  expect(sections[1]?.text).toContain('Угар в каждой фразе')
  expect(sections[1]?.text).toContain('Мат — основа речи')
  expect(sections[1]?.text).toContain('обычным профессиональным языком')
})

test('with the window closed, another session\'s or no robot at all, the prompt is left be', async ($, on) => {
  const robot = world(on, { owner: ME, listeners: 0 })
  await $.session.start({ cwd: '/work', source: 'startup' } as never)

  expect(await sectionIds($)).toEqual(['intro'])
  robot.listeners = 1
  robot.owner = 'another'
  expect(await sectionIds($)).toEqual(['intro'])
  robot.owner = null
  expect(await sectionIds($)).toEqual(['intro'])
  robot.owner = ME
  robot.isUp = false
  expect(await sectionIds($)).toEqual(['intro'])
})
