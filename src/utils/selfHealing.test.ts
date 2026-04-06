import { describe, expect, test } from 'bun:test'
import {
  MAX_SELF_HEALING_RETRIES,
  buildFeedbackMessage,
  isToolErrorMessage,
  makeHealingState,
  recordAttempt,
  shouldRetry,
} from './selfHealing.js'

describe('makeHealingState', () => {
  test('initializes with empty attempts map', () => {
    const state = makeHealingState()
    expect(state.attempts.size).toBe(0)
  })
})

describe('shouldRetry', () => {
  test('returns true when no attempt recorded yet', () => {
    const state = makeHealingState()
    expect(shouldRetry(state, 'tool-use-abc')).toBe(true)
  })

  test('returns true for attempts 1 and 2', () => {
    const state = makeHealingState()
    recordAttempt(state, 'tool-use-abc')
    expect(shouldRetry(state, 'tool-use-abc')).toBe(true)
    recordAttempt(state, 'tool-use-abc')
    expect(shouldRetry(state, 'tool-use-abc')).toBe(true)
  })

  test(`returns false at MAX_SELF_HEALING_RETRIES (${MAX_SELF_HEALING_RETRIES})`, () => {
    const state = makeHealingState()
    for (let i = 0; i < MAX_SELF_HEALING_RETRIES; i++) {
      recordAttempt(state, 'tool-use-abc')
    }
    expect(shouldRetry(state, 'tool-use-abc')).toBe(false)
  })

  test('tracks different tool_use_ids independently', () => {
    const state = makeHealingState()
    for (let i = 0; i < MAX_SELF_HEALING_RETRIES; i++) {
      recordAttempt(state, 'tool-a')
    }
    // tool-a exhausted, tool-b fresh
    expect(shouldRetry(state, 'tool-a')).toBe(false)
    expect(shouldRetry(state, 'tool-b')).toBe(true)
  })
})

describe('recordAttempt', () => {
  test('increments attempt count', () => {
    const state = makeHealingState()
    recordAttempt(state, 'tool-use-x')
    expect(state.attempts.get('tool-use-x')).toBe(1)
    recordAttempt(state, 'tool-use-x')
    expect(state.attempts.get('tool-use-x')).toBe(2)
  })
})

describe('buildFeedbackMessage', () => {
  test('message contains system_error_feedback tag', () => {
    const msg = buildFeedbackMessage('tool-use-123', 'Connection timeout')
    const content = JSON.stringify(msg)
    expect(content).toContain('system_error_feedback')
  })

  test('message contains the error text', () => {
    const msg = buildFeedbackMessage('tool-use-123', 'Zod parse failed: missing field')
    const content = JSON.stringify(msg)
    expect(content).toContain('Zod parse failed')
  })

  test('message contains the tool_use_id', () => {
    const msg = buildFeedbackMessage('tool-use-999', 'timeout')
    const content = JSON.stringify(msg)
    expect(content).toContain('tool-use-999')
  })

  test('message includes stack trace when provided', () => {
    const msg = buildFeedbackMessage('t1', 'err', 'Error\n  at foo (bar.ts:42)')
    const content = JSON.stringify(msg)
    expect(content).toContain('bar.ts:42')
  })

  test('message type is user', () => {
    const msg = buildFeedbackMessage('t1', 'err')
    expect(msg.type).toBe('user')
  })
})

describe('isToolErrorMessage', () => {
  test('returns false for assistant messages', () => {
    const msg = {
      type: 'assistant' as const,
      message: { role: 'assistant' as const, content: [] },
      uuid: 'u1',
      timestamp: 0,
    }
    expect(isToolErrorMessage(msg as Parameters<typeof isToolErrorMessage>[0])).toBe(false)
  })

  test('returns false for user message without tool_result', () => {
    const msg = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hello' }],
      },
      uuid: 'u2',
      timestamp: 0,
    }
    expect(isToolErrorMessage(msg as Parameters<typeof isToolErrorMessage>[0])).toBe(false)
  })

  test('returns false for successful tool_result (is_error = false)', () => {
    const msg = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu1',
            is_error: false,
            content: 'ok',
          },
        ],
      },
      uuid: 'u3',
      timestamp: 0,
    }
    expect(isToolErrorMessage(msg as Parameters<typeof isToolErrorMessage>[0])).toBe(false)
  })

  test('returns detection object for error tool_result', () => {
    const msg = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu-error-42',
            is_error: true,
            content: 'ETIMEDOUT',
          },
        ],
      },
      uuid: 'u4',
      timestamp: 0,
    }
    const result = isToolErrorMessage(msg as Parameters<typeof isToolErrorMessage>[0])
    expect(result).not.toBe(false)
    if (result !== false) {
      expect(result.isError).toBe(true)
      expect(result.toolUseId).toBe('tu-error-42')
      expect(result.errorText).toContain('ETIMEDOUT')
    }
  })
})
