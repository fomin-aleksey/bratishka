// Where the robot's window goes: the largest screen other than the main one,
// filled whole; with no second screen, the window opens as it always did.
//
// macOS keeps each screen's frame from the main screen's bottom-left corner,
// y going up; Chrome places windows from the main screen's top-left corner,
// y going down.

/** A screen as macOS reports it: [x, y, width, height] of all of it and of what windows may use. */
export type Screen = { frame: number[]; visible: number[] }

export type Place = { x: number; y: number; width: number; height: number }

/** Prints every screen's frames as JSON, the main screen first (JavaScript for osascript). */
export const SCREENS_SCRIPT = [
  'ObjC.import("AppKit")',
  'const all = $.NSScreen.screens',
  'const out = []',
  'for (let i = 0; i < all.count; i++) {',
  '  const f = all.objectAtIndex(i).frame, v = all.objectAtIndex(i).visibleFrame',
  '  out.push({ frame: [f.origin.x, f.origin.y, f.size.width, f.size.height],',
  '    visible: [v.origin.x, v.origin.y, v.size.width, v.size.height] })',
  '}',
  'JSON.stringify(out)',
].join('\n')

const isRect = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === 4 && value.every(n => typeof n === 'number' && Number.isFinite(n))

/** The screens in the script's output; none when it is not that. */
export function parseScreens(text: string): Screen[] {
  try {
    const data = JSON.parse(text) as unknown
    if (!Array.isArray(data)) return []
    return data.filter(
      (one): one is Screen =>
        typeof one === 'object' && one !== null && isRect((one as Screen).frame) && isRect((one as Screen).visible),
    )
  } catch {
    return []
  }
}

/** The window's place in Chrome's terms: the largest screen but the main one, whole; none without one. */
export function secondScreen(screens: readonly Screen[]): Place | undefined {
  const [main, ...others] = screens
  if (!main || others.length === 0) return undefined
  const area = (screen: Screen) => (screen.visible[2] ?? 0) * (screen.visible[3] ?? 0)
  const target = others.reduce((best, screen) => (area(screen) > area(best) ? screen : best))
  const [x = 0, y = 0, width = 0, height = 0] = target.visible
  if (width < 1 || height < 1) return undefined

  return {
    x: Math.round(x),
    y: Math.round((main.frame[3] ?? 0) - (y + height)),
    width: Math.round(width),
    height: Math.round(height),
  }
}
