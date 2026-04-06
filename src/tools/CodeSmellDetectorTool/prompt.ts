export const CODE_SMELL_DETECTOR_TOOL_NAME = 'CodeSmellDetector'

export function getCodeSmellDetectorPrompt(): string {
  return `
- Evaluates static code quality metrics across one or more TypeScript/JavaScript files
- Detects common code smells that reduce maintainability without necessarily causing runtime errors
- Returns a per-file metrics report with severity ratings and refactoring priorities

Metrics computed:
  - **Cyclomatic complexity**: number of independent code paths per function (warn ≥ 10, error ≥ 20)
  - **File length**: lines of code per file (warn ≥ 300, error ≥ 500)
  - **Function length**: lines per function (warn ≥ 40, error ≥ 80)
  - **Parameter count**: function arity (warn ≥ 4, error ≥ 7)
  - **Cognitive complexity**: weighted nesting depth score (warn ≥ 15, error ≥ 30)
  - **Dead code**: exported symbols that are never imported within the project
  - **TODO/FIXME density**: ratio of comment markers to lines of code

Usage notes:
  - Provide \`files\`: the source files to analyse
  - Set \`thresholds\` to override default warning/error levels for specific metrics
  - Returns { files: [{ path, metrics: {...}, smells: [{type, severity, line, message}] }], summary: {...} }
  - Severity levels: "info" | "warning" | "error"
  - Read-only: does NOT modify any files
`
}
