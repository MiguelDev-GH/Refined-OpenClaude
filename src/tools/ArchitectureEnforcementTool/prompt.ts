export const ARCHITECTURE_ENFORCEMENT_TOOL_NAME = 'ArchitectureEnforcement'

export function getArchitectureEnforcementPrompt(): string {
  return `
- Inspects newly generated or recently modified code against configurable clean-architecture rules
- Detects violations of SOLID principles, DRY (Don't Repeat Yourself), and Clean Code practices
- Returns actionable violation descriptions with the specific code location and a refactoring suggestion

Checks performed:
  - **SRP (Single Responsibility)**: flags functions/classes that perform multiple conceptually distinct operations
  - **DRY**: detects duplicated logic blocks (>5 identical lines) across the provided files
  - **God Object**: warns when a class/module exports more than a configurable threshold of methods (default: 10)
  - **Deep nesting**: flags control structures nested more than 3 levels deep
  - **Magic numbers/strings**: detects unexplained literal values that should be named constants

Usage notes:
  - Provide \`files\`: the source files to audit
  - Optionally set \`rules\` to enable/disable specific checks: ["srp", "dry", "god_object", "nesting", "magic_values"]
  - Returns { violations: [{rule, file, line, message, suggestion}], score: 0-100 }
  - A score ≥ 80 is considered acceptable for production code
  - Read-only: does NOT modify any files
`
}
