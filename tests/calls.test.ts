import { expect, test } from 'claude-code/testing'

import { kindOf } from '../hooks/calls'

const bash = (command: string) => kindOf('Bash', { command })

test('test runners are told apart from other commands', async () => {
  expect(bash('npm test')).toBe('test')
  expect(bash('pnpm run test -- --watch=false')).toBe('test')
  expect(bash('cd app && python -m pytest -q')).toBe('test')
  expect(bash('"$CLI" plugin test .')).toBe('test')
  expect(bash('go test ./...')).toBe('test')
  expect(bash('cargo test --release')).toBe('test')
  expect(bash('npx vitest run')).toBe('test')
  expect(bash('ls tests')).toBe('')
  expect(bash('cat test-results.txt')).toBe('')
})

test('git commands are not tests', async () => {
  expect(bash('git commit -m "add tests"')).toBe('')
  expect(bash('git push origin main')).toBe('')
})

test('only commands count', async () => {
  expect(kindOf('Read', { file_path: '/work/tests/mod.test.ts' })).toBe('')
  expect(kindOf('Bash', {})).toBe('')
})
