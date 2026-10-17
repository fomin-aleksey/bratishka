import { expect, test } from 'claude-code/testing'

import { createVoice } from '../hooks/voice'
import type { Heard } from '../hooks/voice'

/** Lets every promise that can settle now settle: the module has no timers to wait on. */
const tick = async () => {
  for (let round = 0; round < 50; round++) await Promise.resolve()
}

/** A retelling that answers only when the test lets it, and a window that keeps what it hears. */
const rig = (heard: Heard = 'said') => {
  const asked: string[] = []
  const said: string[] = []
  const answers: ((text: string) => void)[] = []
  const voice = createVoice(
    plain => {
      asked.push(plain)
      return new Promise<string>(resolve => answers.push(resolve))
    },
    async text => {
      said.push(text)
      return heard
    },
  )
  const answer = async (text: string) => {
    answers.shift()?.(text)
    await tick()
  }

  return { voice, asked, said, answer }
}


test('plain Russian is said sentence by sentence as it is written', async () => {
  const { voice, asked, said } = rig()

  voice.write('Короче, на')
  voice.write('шёл. Сейчас')
  await tick()
  expect(said).toEqual(['Короче, нашёл.'])

  voice.write(' поправлю. Да')
  await tick()
  expect(said).toEqual(['Короче, нашёл.', 'Сейчас поправлю.'])

  voice.write('льше сам')
  voice.end()
  await voice.said()
  expect(said).toEqual(['Короче, нашёл.', 'Сейчас поправлю.', 'Дальше сам'])
  expect(asked).toEqual([])
})

test('what is written while a piece is retold goes into the next retelling, in order', async () => {
  const { voice, asked, said, answer } = rig()

  voice.write('Поправил server.py. ')
  voice.write('Проверил в Chrome. ')
  voice.write('Работает на 47219. ')
  voice.write('Готово. ')
  await tick()
  expect(asked).toEqual(['Поправил server.py.'])

  await answer('Поправил файл с сервером.')
  expect(asked).toEqual(['Поправил server.py.', 'Проверил в Chrome.\nРаботает на 47219.\nГотово.'])

  await answer('Проверил в хроме. Работает.')
  await voice.said()
  expect(said).toEqual(['Поправил файл с сервером.', 'Проверил в хроме. Работает.'])
})

test('a plain sentence waits for the retold one before it', async () => {
  const { voice, said, answer } = rig()

  voice.write('Поправил server.py. ')
  voice.end()
  voice.write('Готово, брат. ')
  voice.end()
  await tick()
  expect(said).toEqual([])

  await answer('Поправил файл с сервером.')
  await voice.said()
  expect(said).toEqual(['Поправил файл с сервером.', 'Готово, брат.'])
})

test('code is never said', async () => {
  const { voice, said, asked } = rig()

  voice.write('Вот так.\n```bash\nrm -rf build. Ещё\n```\nВсё.')
  voice.end()
  await voice.said()

  expect(said).toEqual(['Вот так.', 'Всё.'])
  expect(asked).toEqual([])
})

test('once the answer is silenced nothing more of it is said', async () => {
  const { voice, said } = rig('muted')

  voice.write('Раз. ')
  voice.write('Два. ')
  await voice.said()
  voice.write('Три. ')
  voice.end()
  await voice.said()

  expect(said).toEqual(['Раз.'])
})

test('hushed, what was waiting is dropped', async () => {
  const { voice, said, answer } = rig()

  voice.write('Поправил server.py. Готово. ')
  voice.hush()
  await answer('Поправил файл.')
  await voice.said()

  expect(said).toEqual([])
})
