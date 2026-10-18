import type { AiProvider } from './settings'

/** What the assistant is asked to do. */
export type AiTask = 'generate' | 'explain' | 'fix'

export interface AiRequest {
  /** Streamed text arrives as TaskEvents with this id; also used to cancel. */
  taskId: string
  sessionId: string
  task: AiTask
  /** The user's question (generate) or extra instructions (explain, fix). */
  prompt: string
  /** The editor selection, or the statement under the cursor. */
  sql: string
  /** fix: the error the statement produced. */
  error?: string
}

export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export interface AiResult {
  /** The whole reply, as shown in the panel. */
  text: string
  /** The last fenced code block in the reply, if any. Never run automatically. */
  code: string | null
  model: string
  usage: AiUsage | null
  /** Tables left out because the schema was too large to send whole. */
  omittedTables: number
}

export interface AiTestRequest {
  provider: AiProvider
  model: string
  baseUrl: string
}

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  compatible: 'OpenAI-compatible (Ollama, LM Studio…)'
}

export const MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  openai: ['gpt-5', 'gpt-5-mini'],
  compatible: ['llama3.1', 'qwen2.5-coder', 'mistral']
}

/** The last fenced code block, without its fence and language tag. */
export function lastCodeBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)]
  const last = blocks.at(-1)?.[1]?.trim()
  return last ? last : null
}
