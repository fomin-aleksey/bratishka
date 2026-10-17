import { expect, test } from 'claude-code/testing'

import { cleanForSpeech, fallbackSpeech, isLevel, isSpeakable, pieces, readyCut, speechPrompt } from '../hooks/speech'

test('code, tables, links and markup do not reach the voice', async () => {
  const answer = [
    '## Итог',
    '',
    'Поправил **сервер** и `speak.py`, подробности в [README](README.md):',
    '',
    '```bash',
    'rm -rf build',
    '```',
    '',
    '| файл | что |',
    '|---|---|',
    '| a.py | ок |',
    '',
    '- первый пункт',
    '- второй пункт, см. https://example.com/x',
  ].join('\n')

  const plain = cleanForSpeech(answer)

  expect(plain).toContain('Итог')
  expect(plain).toContain('Поправил сервер и speak.py, подробности в README:')
  expect(plain).toContain('первый пункт')
  expect(plain).not.toContain('rm -rf')
  expect(plain).not.toContain('|')
  expect(plain).not.toContain('**')
  expect(plain).not.toContain('https://')
  expect(plain).not.toContain('##')
})

test('without the model the text is cut to the level and Latin is dropped', async () => {
  const plain = 'Готово, брат. Поправил server.py как надо. Проверил в Chrome. Всё летает. Пятое предложение.'

  expect(fallbackSpeech(plain, 'min')).toBe('Готово, брат.')
  expect(fallbackSpeech(plain, 'mid')).toBe('Готово, брат. Поправил как надо. Проверил в.')
  expect(fallbackSpeech(plain, 'full').split('. ').length).toBe(5)
})

test('the prompt names the task of each level and carries the answer', async () => {
  expect(speechPrompt('Текст ответа.', 'min')).toContain('пятнадцати слов')
  expect(speechPrompt('Текст ответа.', 'full')).toContain('Это кусок длинного ответа')
  expect(speechPrompt('Текст ответа.', 'mid')).toContain('<answer>\nТекст ответа.\n</answer>')
})

test('only the four levels are levels', async () => {
  expect(['min', 'mid', 'max', 'full'].every(isLevel)).toBe(true)
  expect(isLevel('loud')).toBe(false)
  expect(isLevel(undefined)).toBe(false)
})

test('a whole answer is cut into pieces of whole sentences', async () => {
  expect(pieces('Раз два. Три четыре. Пять.', 20)).toEqual(['Раз два. Три четыре.', 'Пять.'])
  expect(pieces('Раз два. Три четыре. Пять.', 12)).toEqual(['Раз два.', 'Три четыре.', 'Пять.'])
  expect(pieces('Одно очень длинное предложение без точки внутри', 10)).toEqual([
    'Одно очень длинное предложение без точки внутри',
  ])
  expect(pieces('Абзац один.\n\nАбзац два.', 100)).toEqual(['Абзац один. Абзац два.'])
})

test('of a text being written, the whole sentences and lines are ready', async () => {
  const ready = (raw: string) => raw.slice(0, readyCut(raw))

  expect(ready('Короче, нашёл. Сейчас поправ')).toBe('Короче, нашёл. ')
  expect(ready('Короче, нашёл')).toBe('')
  expect(ready('Готово!» А дальше')).toBe('Готово!» ')
  expect(ready('**Короче.** Дальше')).toBe('**Короче.** ')
  expect(ready('## Итог\nПоправил сер')).toBe('## Итог\n')
  expect(ready('1. Первый пу')).toBe('')
  expect(ready('Смотри `a. b` тут')).toBe('')
})

test('nothing inside a block of code or a table row is ready', async () => {
  const ready = (raw: string) => raw.slice(0, readyCut(raw))

  expect(ready('Вот код.\n```js\nconsole.log(1). Ещё\n')).toBe('Вот код.\n')
  expect(ready('Вот код.\n```js\nx()\n```\nВсё. Дал')).toBe('Вот код.\n```js\nx()\n```\nВсё. ')
  expect(ready('| файл | что. Тут | ещё')).toBe('')
})

test('plain Russian is said as written, anything else is retold', async () => {
  expect(isSpeakable('Короче, нашёл, где тормозит — щас поправлю!')).toBe(true)
  expect(isSpeakable('Поправил server.py.')).toBe(false)
  expect(isSpeakable('Три секунды, а не 3.')).toBe(false)
  expect(isSpeakable('Сто %')).toBe(false)
  expect(isSpeakable('...')).toBe(false)
})

test('half of a bold pair does not reach the voice', async () => {
  expect(cleanForSpeech('**Слушай.')).toBe('Слушай.')
})
