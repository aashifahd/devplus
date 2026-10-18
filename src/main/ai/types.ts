import type { AiUsage } from '@shared/ai'

/** One streamed completion, independent of the provider. */
export interface ProviderCall {
  apiKey: string | null
  model: string
  baseUrl: string
  /** Stable instructions (identical across requests). */
  instructions: string
  /** Schema for the current connection (identical across requests on that connection). */
  schema: string
  /** The per-request message. */
  user: string
  signal: AbortSignal
  onText(delta: string): void
}

export interface ProviderReply {
  text: string
  model: string
  usage: AiUsage | null
}
