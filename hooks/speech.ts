// Turning a written answer into what the robot says aloud.
//
// Silero reads Russian letters only: Latin words, digits and symbols are
// swallowed or mangled. So the answer is first stripped of code and markup,
// then a small model retells it at the chosen length in speakable Russian.
// Without the model, the stripped text is cut to length as it is.

export type Level = 'min' | 'mid' | 'max' | 'full'

export const LEVELS: readonly Level[] = ['min', 'mid', 'max', 'full']

export const isLevel = (value: unknown): value is Level =>
  typeof value === 'string' && (LEVELS as readonly string[]).includes(value)

/** The longest stripped answer handed to the model. */
const MAX_INPUT = 14000

/** The written answer with code, tables, links and markup taken out. */
export function cleanForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .split('\n')
    .filter(line => !/^\s*\|/.test(line))
    .map(line =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*([-*+]|\d+[.)])\s+/, ''),
    )
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    // A piece cut off mid-answer may hold one half of a bold pair.
    .replace(/\*{2,}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, MAX_INPUT)
}

export const SPEECH_SYSTEM = [
  'Ты готовишь текст для синтеза речи. Голосовой движок читает только русские буквы: латиницу, цифры и значки он проглатывает или коверкает.',
  'Правила:',
  '- Говори от первого лица, как будто автор ответа сам рассказывает собеседнику вслух. Сохрани его тон и манеру, крепкие словечки тоже.',
  '- Только связная разговорная речь: без разметки, списков, заголовков и эмодзи.',
  '- Код, команды, пути к файлам и адреса не зачитывай: скажи по-человечески, что это, например «поправил файл с сервером».',
  '- Английские слова и названия пиши русскими буквами так, как их произносят: «клод», «гитхаб», «пайтон», «вебджиэл».',
  '- Числа, даты, проценты и единицы пиши словами: «двадцать пять процентов», «три секунды».',
  '- Аббревиатуры пиши так, как их произносят: «эй-пи-ай», «ю-ай».',
  '- Предложения короткие, каждое кончается точкой, вопросом или восклицанием.',
  '- Выдай только текст для озвучки, без пояснений и кавычек вокруг.',
].join('\n')

const TASK: Record<Level, string> = {
  min: 'Одна короткая фраза, не длиннее пятнадцати слов: самая суть ответа.',
  mid: 'Два-три предложения, не длиннее сорока пяти слов: суть и главный вывод.',
  max: 'Подробный пересказ: пять-восемь предложений, не длиннее ста тридцати слов, все ключевые пункты и выводы.',
  full: 'Это кусок длинного ответа. Перескажи его целиком, почти дословно и в том же порядке, ничего не сокращай и не добавляй вступлений, обращений и выводов, которых в нём нет; только переложи в устную речь по правилам.',
}

/** The model's reply cap for each level, in tokens. */
export const MAX_TOKENS: Record<Level, number> = { min: 200, mid: 400, max: 900, full: 1500 }

/** The longest piece of a whole answer retold at once, in characters. */
export const FULL_PIECE = 600

/**
 * The text cut into pieces of whole sentences, each at most `limit` long
 * unless one sentence alone is longer: retold side by side and said in turn,
 * the first piece is heard while the rest are still being retold.
 */
export function pieces(plain: string, limit: number = FULL_PIECE): string[] {
  const sentences = plain.split(/(?<=[.!?…])\s+|\n+/).map(part => part.trim()).filter(Boolean)
  return sentences.reduce<string[]>((done, sentence) => {
    const last = done[done.length - 1]
    if (last !== undefined && last.length + 1 + sentence.length <= limit) {
      return [...done.slice(0, -1), `${last} ${sentence}`]
    }
    return [...done, sentence]
  }, [])
}

/**
 * A sentence's end inside a line: its mark after a letter or a digit, closing
 * quotes, brackets or bold, then a space.
 */
const SENTENCE_END = /(?<=[\p{L}\p{N}»"')\]*])[.!?…]+[»"')\]*]*\s+/gu

/** A numbered list's marker ("1. ") at the start of a line: not a sentence's end. */
const LIST_NUMBER = /^\s*\d+$/

/** Whether an odd number of backticks stand before `at`: inside inline code. */
const isInCode = (line: string, at: number): boolean => (line.slice(0, at).match(/`/g) ?? []).length % 2 === 1

/**
 * How much of a text still being written can be said already: the whole
 * lines and, in the line being written, the whole sentences, never inside a
 * block of code or a table row; 0 while nothing is whole yet.
 */
export function readyCut(raw: string): number {
  const lines = raw.split('\n')
  const writing = lines.pop() ?? ''
  const { cut, start, isCode } = lines.reduce(
    (done, line) => {
      const next = done.start + line.length + 1
      const isCodeAfter = /^\s*(```|~~~)/.test(line) ? !done.isCode : done.isCode
      return { cut: isCodeAfter ? done.cut : next, start: next, isCode: isCodeAfter }
    },
    { cut: 0, start: 0, isCode: false },
  )
  if (isCode || /^\s*(\||```|~~~)/.test(writing)) return cut
  const ends = [...writing.matchAll(SENTENCE_END)]
    .filter(match => !LIST_NUMBER.test(writing.slice(0, match.index ?? 0)))
    .map(match => (match.index ?? 0) + match[0].length)
    .filter(at => !isInCode(writing, at))
  const last = ends[ends.length - 1]

  return last === undefined ? cut : start + last
}

/** Plain Russian the voice reads as written: Cyrillic, spaces and punctuation, nothing to retell. */
export const isSpeakable = (plain: string): boolean =>
  /[А-Яа-яЁё]/.test(plain) && /^[А-Яа-яЁё\s.,!?…:;«»"'()—–-]+$/.test(plain)

export const speechPrompt = (plain: string, level: Level): string =>
  `Задача: ${TASK[level]}\n\nОтвет, который нужно озвучить:\n<answer>\n${plain}\n</answer>`

const SENTENCES: Record<Level, number> = { min: 1, mid: 3, max: 8, full: Infinity }

/** Without the model: the stripped text, Latin dropped, cut to the level's length. */
export function fallbackSpeech(plain: string, level: Level): string {
  const readable = plain
    .replace(/[A-Za-z][A-Za-z0-9_/\\-]*(\.[A-Za-z0-9_]+)*/g, ' ')
    .replace(/[{}[\]<>|=#*_~^$@%&+\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?…:;])/g, '$1')
    .trim()
  const sentences = readable.split(/(?<=[.!?…])\s+/).filter(part => /[А-Яа-яЁё]/.test(part))
  return sentences.slice(0, SENTENCES[level]).join(' ')
}
