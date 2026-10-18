import { lastCodeBlock, type AiRequest, type AiResult, type AiTestRequest } from '@shared/ai'
import * as store from '../store'
import { engineOf, getDriver } from '../sessions'
import { instructions, schemaContext, userMessage } from './context'
import { streamAnthropic, testAnthropic } from './anthropic'
import { streamOpenAi, testOpenAi } from './openai'

const running = new Map<string, AbortController>()

export async function ask(req: AiRequest, onText: (delta: string) => void): Promise<AiResult> {
  const { ai } = store.getSettings()
  const driver = getDriver(req.sessionId)
  const engine = engineOf(req.sessionId)
  const controller = new AbortController()
  running.get(req.taskId)?.abort()
  running.set(req.taskId, controller)
  try {
    const schema = await schemaContext(driver, engine, req, ai.includeSampleRows)
    if (controller.signal.aborted) throw new Error('Cancelled.')
    const call = {
      apiKey: store.getAiKey(ai.provider),
      model: ai.model.trim(),
      baseUrl: ai.baseUrl,
      instructions: instructions(engine),
      schema: schema.text,
      user: userMessage(req),
      signal: controller.signal,
      onText
    }
    if (!call.model) throw new Error('Choose a model in Settings → AI assistant.')
    const reply = ai.provider === 'anthropic' ? await streamAnthropic(call) : await streamOpenAi(call, ai.provider === 'openai')
    return {
      text: reply.text,
      code: req.task === 'explain' ? null : lastCodeBlock(reply.text),
      model: reply.model,
      usage: reply.usage,
      omittedTables: schema.omittedTables
    }
  } finally {
    if (running.get(req.taskId) === controller) running.delete(req.taskId)
  }
}

export function cancel(taskId: string) {
  running.get(taskId)?.abort()
}

export function test(t: AiTestRequest): Promise<string> {
  const key = store.getAiKey(t.provider)
  const model = t.model.trim()
  if (!model) throw new Error('Choose a model first.')
  return t.provider === 'anthropic' ? testAnthropic(key, model) : testOpenAi(key, model, t.baseUrl, t.provider === 'openai')
}
