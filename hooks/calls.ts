// What a tool call means to the robot's effects in its window: whether it
// runs tests. Failed tests glitch the robot harder than any other failure.

/** What a call may mean: tests, or nothing in particular. */
export type CallKind = 'test' | ''

/** Test runners, as they start a command or follow `npx`, `cd … &&` and the like. */
const TESTS = new RegExp(
  [
    String.raw`\b(?:pytest|jest|vitest|mocha|phpunit|rspec)\b`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b`,
    String.raw`\b(?:go|cargo|deno|dotnet|mix|swift|mvn|make)\s+test\b`,
    String.raw`\bgradlew?\s+test\b`,
    String.raw`\bplugin\s+test\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest)\b`,
  ].join('|'),
)

/** What a call means to the robot: a command that runs tests, or nothing in particular. */
export const kindOf = (tool: string, input: Record<string, unknown>): CallKind => {
  const command = input.command
  return tool === 'Bash' && typeof command === 'string' && TESTS.test(command) ? 'test' : ''
}
