import Anthropic from '@anthropic-ai/sdk'
import type { AiUsage } from '@shared/ai'
import type { ProviderCall, ProviderReply } from './types'

/** Models that take adaptive thinking and an effort level; anything else gets a plain request. */
const ADAPTIVE = /^claude-(fable|mythos)-|^claude-(opus|sonnet|haiku)-5|^claude-opus-4-[678]|^claude-sonnet-4-6/
/** Models with server-side refusal fallback on the Claude API. */
const FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/

function friendly(err: unknown, model: string): Error {
  if (err instanceof Anthropic.APIUserAbortError) return new Error('Cancelled.')
  if (err instanceof Anthropic.AuthenticationError) return new Error('Anthropic rejected the API key. Check it in Settings → AI assistant.')
  if (err instanceof Anthropic.PermissionDeniedError) return new Error(`This API key can't use ${model}.`)
  if (err instanceof Anthropic.NotFoundError) return new Error(`Anthropic doesn't know the model "${model}".`)
  if (err instanceof Anthropic.RateLimitError) return new Error('Anthropic rate limit reached. Try again in a moment.')
  if (err instanceof Anthropic.BadRequestError) return new Error(`Anthropic refused the request: ${err.message}`)
  if (err instanceof Anthropic.APIConnectionError) return new Error("Couldn't reach the Anthropic API. Check your network connection.")
  if (err instanceof Anthropic.APIError) return new Error(`Anthropic error ${err.status ?? ''}: ${err.message}`.trim())
  return err instanceof Error ? err : new Error(String(err))
}

export async function streamAnthropic(c: ProviderCall): Promise<ProviderReply> {
  if (!c.apiKey) throw new Error('Add an Anthropic API key in Settings → AI assistant.')
  const client = new Anthropic({ apiKey: c.apiKey, maxRetries: 2 })
  const adaptive = ADAPTIVE.test(c.model)
  const fallback = FALLBACK.test(c.model)
  try {
    const stream = client.beta.messages.stream(
      {
        model: c.model,
        max_tokens: 64000,
        // Instructions, then the schema with a cache breakpoint: follow-up questions
        // on the same connection reuse the cached prefix.
        system: [
          { type: 'text', text: c.instructions },
          { type: 'text', text: c.schema, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{ role: 'user', content: c.user }],
        ...(adaptive ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'medium' as const } } : {}),
        // If the model declines on policy grounds, the API retries on its default fallback model.
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
      },
      { signal: c.signal }
    )
    stream.on('text', (delta) => c.onText(delta))
    const message = await stream.finalMessage()

    const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    if (message.stop_reason === 'refusal') {
      const why = message.stop_details?.explanation
      throw new Error(`The model declined this request${why ? `: ${why}` : '.'}`)
    }
    const usage: AiUsage = {
      inputTokens: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0
    }
    const suffix = message.stop_reason === 'max_tokens' ? '\n\n(The reply was cut off at the length limit.)' : ''
    return { text: text + suffix, model: message.model, usage }
  } catch (err) {
    throw friendly(err, c.model)
  }
}

/** Check the key and model without spending tokens. */
export async function testAnthropic(apiKey: string | null, model: string): Promise<string> {
  if (!apiKey) throw new Error('No Anthropic API key saved yet.')
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  try {
    const info = await client.models.retrieve(model)
    return `Connected. ${info.display_name} is available.`
  } catch (err) {
    throw friendly(err, model)
  }
}
