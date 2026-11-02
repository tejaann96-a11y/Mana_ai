import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { PassThrough } from 'node:stream'

// Exercise the actual Netlify handler and Gemini SDK without cloud or user data.
process.env.NODE_ENV = 'test'
process.env.NETLIFY = 'true'
process.env.AI_PROVIDER = 'ollama'
process.env.AI_FALLBACK_ENABLED = 'true'
process.env.AI_FALLBACK_PROVIDER = 'gemini'
process.env.GEMINI_API_KEY = 'mock-gemini-lifecycle-key'
process.env.GEMINI_MODEL = 'gemini-3.8-flash'
;(globalThis as any).awslambda = { streamifyResponse: (handler: unknown) => handler }
const { handleChatStream } = await import('../netlify/functions/chat-stream.js')
const { getGeminiTimeoutMs, classifyGeminiError } = await import('../server/services/aiService.js')
const originalFetch = globalThis.fetch
const prompt = 'Please give a brief greeting.'
let calls: any[] = []

async function request(history: any[] = []) {
  return await handleChatStream({
    body: JSON.stringify({ prompt, history, searchMode: 'never' }), headers: {},
  } as any, {} as any)
}
async function collect(response: Awaited<ReturnType<typeof request>>) {
  assert.equal(response.statusCode, 200)
  assert.match(response.headers!['Content-Type'] as string, /text\/event-stream/)
  let text = ''
  for await (const chunk of response.body as PassThrough) text += chunk.toString()
  return text.split('\n\n').filter(block => block.startsWith('event:')).map(block => {
    const [event, data] = block.split('\n')
    return { event: event.slice(7), data: JSON.parse(data.slice(6)) }
  })
}
function successFetch() {
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(init!.body as string))
    return new Response('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello.' }] }, finishReason: 'STOP', index: 0 }] }) + '\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
}
function hangingFetch(onStarted?: () => void) {
  globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(init?.signal?.reason)
    if (init?.signal?.aborted) abort()
    else init?.signal?.addEventListener('abort', abort, { once: true })
    onStarted?.()
  })
}
try {
  process.env.GEMINI_TIMEOUT_MS = '120000'
  assert.equal(getGeminiTimeoutMs(), 20000, 'Cloud timeout must stay below Lambda limit even when configured higher')
  delete process.env.NETLIFY
  assert.equal(getGeminiTimeoutMs(), 120000, 'Local timeout configuration remains supported')
  process.env.NETLIFY = 'true'
  delete process.env.GEMINI_TIMEOUT_MS
  successFetch()
  for (const history of [[], [{ role: 'user', content: 'An earlier greeting' }, { role: 'assistant', content: 'An earlier answer' }], []]) {
    const events = await collect(await request(history))
    assert.deepEqual(events.map(x => x.event).filter(x => x !== 'search_status'), ['provider_fallback', 'token', 'done'])
    assert.equal(events.at(-1)?.data.provider, 'gemini')
  }
  assert.equal(calls.length, 3, 'Consecutive messages and new chat each use exactly one Gemini request')
  assert.deepEqual(calls[1].contents.slice(0, 2).map((x: any) => x.role), ['user', 'model'])
  assert.equal(calls[1].contents[0].parts[0].text, 'An earlier greeting')
  console.log('PASS fallback, completion, two consecutive messages, new chat, and preserved history')

  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Diagnostic provider failure' } }), { status })
    const events = await collect(await request())
    assert.equal(events.at(-1)?.event, 'error')
    assert.equal(events.at(-1)?.data.status, status)
    assert.equal(events.filter(x => x.event === 'error').length, 1)
    assert.equal(events.filter(x => x.event === 'done').length, 0)
    assert(!events.at(-1)?.data.message.includes(process.env.GEMINI_API_KEY!))
    if (status === 429) assert.match(events.at(-1)?.data.message, /rate limit/)
    if (status === 401) assert.match(events.at(-1)?.data.message, /Invalid Google Gemini API key/)
  }
  assert.doesNotMatch(classifyGeminiError({ status: 503 }).message, /timed out/)
  console.log('PASS distinct HTTP 400/401/403/404/429/500/503 errors and both providers unavailable')

  process.env.GEMINI_TIMEOUT_MS = '25'
  hangingFetch()
  // AbortSignal.timeout uses an unref'd timer, so keep the standalone test alive.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const events = await collect(await request())
    assert.equal(events.at(-1)?.data.code, 'provider_timeout')
    assert.match(events.at(-1)?.data.message, /request timed out/)
  } finally { clearInterval(keepAlive) }
  delete process.env.GEMINI_TIMEOUT_MS
  console.log('PASS Gemini timeout emits a useful terminal error and closes SSE')

  let started!: () => void
  const upstreamStarted = new Promise<void>(resolve => { started = resolve })
  hangingFetch(started)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const response = await request()
    const body = collect(response)
    await upstreamStarted
    mock.timers.tick(25000)
    const events = await body
    assert.equal(events.at(-1)?.data.code, 'request_timeout')
    assert.equal(events.filter(x => x.event === 'error').length, 1)
  } finally { mock.timers.reset() }
  console.log('PASS whole-request deadline closes SSE before the production 30s limit')

  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Partial' }] } }] }) + '\n\n')
  const incomplete = await collect(await request())
  assert.equal(incomplete.at(-1)?.event, 'error', 'An incomplete provider stream must never claim success')
  console.log('PASS incomplete Gemini stream reports failure instead of done')
} finally {
  globalThis.fetch = originalFetch
  mock.timers.reset()
}
