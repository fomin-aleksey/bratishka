import { expect, test } from 'claude-code/testing'

import { parseScreens, secondScreen } from '../hooks/screens'

/** The MacBook's screen and, above it and a little to the left, the Mi monitor. */
const DESK = [
  { frame: [0, 0, 1512, 982], visible: [0, 57, 1512, 887] },
  { frame: [-1000, 982, 3440, 1440], visible: [-1000, 982, 3440, 1440] },
]

test('the window fills the second screen, in Chrome\'s top-left terms', async () => {
  expect(secondScreen(DESK)).toEqual({ x: -1000, y: -1440, width: 3440, height: 1440 })
})

test('with the main screen alone there is no second one', async () => {
  expect(secondScreen(DESK.slice(0, 1))).toBeUndefined()
  expect(secondScreen([])).toBeUndefined()
})

test('of two other screens the larger one is taken', async () => {
  const small = { frame: [1512, 0, 1280, 800], visible: [1512, 0, 1280, 775] }

  expect(secondScreen([DESK[0]!, small, DESK[1]!])?.width).toBe(3440)
})

test('anything but the script\'s list of screens reads as none', async () => {
  expect(parseScreens('')).toEqual([])
  expect(parseScreens('{"frame": 1}')).toEqual([])
  expect(parseScreens('[{"frame": [0, 0, 1, "x"], "visible": [0, 0, 1, 1]}]')).toEqual([])
  expect(parseScreens(JSON.stringify(DESK))).toEqual(DESK)
})
