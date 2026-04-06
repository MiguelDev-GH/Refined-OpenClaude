export const TDD_VALIDATION_TOOL_NAME = 'TDDValidation'

export function getTDDValidationPrompt(): string {
  return `
- Runs the project's test suite (bun test, jest, vitest) scoped only to files affected by recent changes
- Detects the test runner automatically from package.json scripts and installed dependencies
- Returns pass/fail per test, error messages, and stack traces for failures
- Enforces TDD discipline: write test → write code → validate → advance only on green

Usage notes:
  - Provide \`targetFiles\` — the source files you modified — and the tool discovers matching test files automatically
  - Set \`testPattern\` to restrict to specific test files if auto-discovery is too broad
  - \`bail\` (default: true) stops on first failure for faster feedback
  - Returns structured results: { passed: number, failed: number, tests: [{name, status, error?}] }
  - Does NOT write or modify test files — run-only
`
}
