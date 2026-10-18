import type { AiUsage } from '@shared/ai'
import type { ProviderCall, ProviderReply } from './types'

export const OPENAI_BASE = 'https://api.openai.com/v1'

const trimSlash = (u: string) => u.replace(/\/+$/, '')

async function httpError(res: Response, label: string, model: string): Promise<Error> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail = typeof body.error === 'string' ? body.error : body.error?.message ?? ''
  } catch {
    // Not JSON; the status says enough.
  }
  if (res.status === 401) return new Error(`${label} rejected the API key.`)
  if (res.status === 404) return new Error(`${label} doesn't know the model "${model}"${detail ? `: ${detail}` : '.'}`)
  if (res.status === 429) return new Error(`${label} rate limit reached. Try again in a moment.`)
  return new Error(`${label} error ${res.status}${detail ? `: ${detail}` : ''}`)
}

function reachError(err: unknown, label: string, baseUrl: string): Error {
  if (err instanceof Error && err.name === 'AbortError') return new Error('Cancelled.')
  return new Error(`Couldn't reach ${label} at ${baseUrl}: ${(err as Error).message}`)
}

/** Chat Completions with server-sent events, as spoken by OpenAI and most local servers. */
export async function streamOpenAi(c: ProviderCall, hosted: boolean): Promise<ProviderReply> {
  const label = hosted ? 'OpenAI' : 'The server'
  const base = trimSlash(hosted ? OPENAI_BASE : c.baseUrl)
  if (hosted && !c.apiKey) throw new Error('Add an OpenAI API key in Settings → AI assistant.')
  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({
        model: c.model,
        stream: true,
        ...(hosted ? { stream_options: { include_usage: true } } : {}),
        messages: [
          { role: 'system', content: `${c.instructions}\n\n${c.schema}` },
          { role: 'user', content: c.user }
        ]
      }),
      signal: c.signal
    })
  } catch (err) {
    throw reachError(err, label, base)
  }
  if (!res.ok || !res.body) throw await httpError(res, label, c.model)

  let text = ''
  let model = c.model
  let usage: AiUsage | null = null
  let buffer = ''
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk: {
          model?: string
          choices?: { delta?: { content?: string | null } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null
          error?: { message?: string }
        }
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (chunk.error) throw new Error(`${label} error: ${chunk.error.message ?? 'unknown'}`)
        if (chunk.model) model = chunk.model
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) {
          text += delta
          c.onText(delta)
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('Cancelled.')
    throw err
  }
  return { text, model, usage }
}

/** List models to check the address and key; confirms the chosen model when the server reports it. */
export async function testOpenAi(apiKey: string | null, model: string, baseUrl: string, hosted: boolean): Promise<string> {
  const label = hosted ? 'OpenAI' : 'The server'
  const base = trimSlash(hosted ? OPENAI_BASE : baseUrl)
  if (hosted && !apiKey) throw new Error('No OpenAI API key saved yet.')
  let res: Response
  try {
    res = await fetch(`${base}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw reachError(err, label, base)
  }
  if (!res.ok) throw await httpError(res, label, model)
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] }
  const ids = (body.data ?? []).map((m) => m.id)
  if (ids.length && !ids.some((id) => id === model || id.split(':')[0] === model)) {
    throw new Error(`Connected, but "${model}" isn't in the server's model list. Available: ${ids.slice(0, 12).join(', ')}`)
  }
  return `Connected. ${ids.length ? `${ids.length} models available.` : ''}`.trim()
}
