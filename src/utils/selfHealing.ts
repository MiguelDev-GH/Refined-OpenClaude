import type { Message } from '../types/message.js'

export const MAX_SELF_HEALING_RETRIES = 3

export type HealingState = {
  attempts: Map<string, number>
}

/** Create fresh healing state for a new turn. */
export function makeHealingState(): HealingState {
  return { attempts: new Map() }
}

/** True when another retry is available for the given tool_use_id. */
export function shouldRetry(state: HealingState, toolUseId: string): boolean {
  return (state.attempts.get(toolUseId) ?? 0) < MAX_SELF_HEALING_RETRIES
}

/** Record one failed attempt for the given tool_use_id. */
export function recordAttempt(state: HealingState, toolUseId: string): void {
  state.attempts.set(toolUseId, (state.attempts.get(toolUseId) ?? 0) + 1)
}

/**
 * Build a synthetic user message that carries error diagnostics back to the
 * LLM as a <system_error_feedback> block so the model can self-correct.
 * The message is typed as a normal `user` message to slot into mutableMessages
 * without touching the API schema.
 */
export function buildFeedbackMessage(
  toolUseId: string,
  errorText: string,
  stackTrace?: string,
): Message {
  const attempt = 'N' // caller tracks attempt number; kept generic here
  const body = [
    `<system_error_feedback>`,
    `tool_use_id: ${toolUseId}`,
    `attempt: ${attempt}`,
    `error: ${errorText}`,
    stackTrace ? `stack_trace:\n${stackTrace}` : '',
    ``,
    `You are acting as ErrorDiagnosisExpert. Analyse the error above, infer the`,
    `root cause, and retry the tool call with corrected parameters or a revised`,
    `approach. Do not report this failure to the user yet — resolve it silently.`,
    `</system_error_feedback>`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    type: 'user',
    isMeta: true, // hidden from user-facing display
    message: {
      role: 'user',
      content: body,
    },
    uuid: crypto.randomUUID(),
    timestamp: Date.now(),
  } as unknown as Message // cast: isMeta is internal; Message union is wide
}

/**
 * Inspect a message to determine whether it is a tool error user message.
 *
 * Returns `false` when the message is not a user tool-result message or the
 * result is a success.  Returns a detection object when an `is_error: true`
 * tool_result is found.
 */
export function isToolErrorMessage(
  message: Message,
): { isError: true; toolUseId: string; errorText: string } | false {
  if (message.type !== 'user') return false

  const content = message.message?.content
  if (!Array.isArray(content)) return false

  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'tool_result' &&
      'is_error' in block &&
      block.is_error === true
    ) {
      const toolUseId =
        'tool_use_id' in block && typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : 'unknown'
      const raw = 'content' in block ? block.content : ''
      const errorText =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw
                .map((b: unknown) =>
                  b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '',
                )
                .join(' ')
            : String(raw)
      return { isError: true, toolUseId, errorText }
    }
  }

  return false
}
