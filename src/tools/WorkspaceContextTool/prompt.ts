export const WORKSPACE_CONTEXT_TOOL_NAME = 'WorkspaceContext'

export function getWorkspaceContextPrompt(): string {
  return `
- Reads foundation files (package.json, tsconfig.json, README.md, docker-compose.yml, .env.example, bun.lock) to build a complete picture of the project's tech stack
- Returns a structured summary of: runtime, frameworks, key dependencies, build tools, test runner, and entry points
- Call this tool BEFORE writing any code in an unfamiliar project to avoid syntax/library mismatches
- Results guide which APIs, import paths, and patterns to use throughout the task

Usage notes:
  - Automatically detects the project root (nearest package.json)
  - Summarizes only what is relevant to code generation (skips unrelated config sections)
  - Lightweight read-only operation — safe to call at the start of any session
`
}
