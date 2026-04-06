export const TYPE_CHECKER_TOOL_NAME = 'TypeChecker'

export function getTypeCheckerPrompt(): string {
  return `
- Runs TypeScript compiler (tsc --noEmit) or ESLint on one or more specific files immediately after they are written or edited
- Returns structured type errors, lint violations, and their exact line/column positions
- Use this tool silently after every file write to catch type errors before presenting the result to the user
- Enables self-correction: fix errors immediately in the same response without requiring user feedback

Usage notes:
  - Set \`files\` to the specific files just written — do not run on the entire project unless requested
  - \`mode\` can be "typecheck" (tsc), "lint" (eslint), or "both"
  - Returns [] errors on success — only call if you need confirmation before advancing
  - Does NOT modify files — diagnosis only
  - Falls back gracefully if tsconfig.json is not found
`
}
