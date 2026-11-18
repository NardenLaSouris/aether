/**
 * Test double for the SDK `Query`: the test pushes SDK messages, the runner consumes them.
 * Used only in tests — the application never fabricates engine output.
 */
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { MessageQueue } from '../../../src/engine-host/messageQueue'

export interface FakeQueryHandle {
  query: Query
  options: Options
  prompt: AsyncIterable<SDKUserMessage>
  emit(message: Record<string, unknown>): void
  finish(): void
  fail(error: Error): void
  calls: { interrupt: number; setModel: (string | undefined)[]; setPermissionMode: string[]; close: number }
  receivedPrompts: SDKUserMessage[]
}

export function createFakeQueryFactory(): { factory: (parameters: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query; handles: FakeQueryHandle[] } {
  const handles: FakeQueryHandle[] = []
  const factory = (parameters: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    const output = new MessageQueue<SDKMessage>()
    let failure: Error | null = null
    const calls = { interrupt: 0, setModel: [] as (string | undefined)[], setPermissionMode: [] as string[], close: 0 }
    const receivedPrompts: SDKUserMessage[] = []
    void (async () => {
      for await (const message of parameters.prompt) receivedPrompts.push(message)
    })()
    const iterator = output[Symbol.asyncIterator]()
    const query = {
      next: async () => {
        if (failure) throw failure
        const result = await iterator.next()
        if (failure) throw failure
        return result
      },
      return: async () => ({ value: undefined, done: true as const }),
      throw: async (error: unknown) => {
        throw error
      },
      [Symbol.asyncIterator]() {
        return this
      },
      interrupt: async () => {
        calls.interrupt += 1
        return undefined
      },
      setModel: async (model?: string) => {
        calls.setModel.push(model)
      },
      setPermissionMode: async (mode: string) => {
        calls.setPermissionMode.push(mode)
      },
      close: () => {
        calls.close += 1
        output.end()
      },
      initializationResult: async () => ({
        commands: [{ name: 'review', description: 'Review', argumentHint: '' }],
        agents: [],
        output_style: 'default',
        available_output_styles: [],
        models: [{ value: 'model-a', displayName: 'Model A', description: 'First test model' }],
        account: { email: 'test@example.com', subscriptionType: 'pro' },
        claude_code_version: '9.9.9'
      }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        session: { total_cost_usd: 0.5, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 42, resets_at: '2030-01-01T10:00:00Z' }, seven_day: { utilization: 10, resets_at: '2030-01-05T10:00:00Z' } },
        behaviors: null
      })
    } as unknown as Query
    const handle: FakeQueryHandle = {
      query,
      options: parameters.options,
      prompt: parameters.prompt,
      emit: (message) => output.push(message as unknown as SDKMessage),
      finish: () => output.end(),
      fail: (error) => {
        failure = error
        output.end()
      },
      calls,
      receivedPrompts
    }
    handles.push(handle)
    return query
  }
  return { factory, handles }
}

export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
