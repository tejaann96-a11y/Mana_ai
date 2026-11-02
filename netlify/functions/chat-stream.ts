import { stream } from '@netlify/functions'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { connectLambda } from '@netlify/blobs'
import { orchestrateChat } from '../../server/services/chatOrchestrator.js'
import { authService } from '../../server/services/authService.js'

export const handleChatStream: Parameters<typeof stream>[0] = async (event, _context) => {
  // Connect Netlify Blobs runtime context
  try {
    connectLambda(event)
  } catch { }

  let body: any = {}
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    }
  }

  const {
    prompt,
    history = [],
    searchMode,
    reasoningMode,
    aiProvider,
    modelName,
    ollamaBaseUrl,
    ollamaModel,
    geminiApiKey,
    openaiApiKey,
    groqApiKey,
  } = body

  if (!prompt || typeof prompt !== 'string' || !prompt.trim() || !Array.isArray(history)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Valid prompt string is required' }),
    }
  }

  // Extract auth credentials if present
  const authHeader = event.headers?.['authorization'] || event.headers?.['Authorization']
  let authUser: any = null
  if (authHeader && authHeader.startsWith('Bearer ')) {
    authUser = authService.verifyToken(authHeader.slice(7))
  }

  const requestId = randomUUID()
  const primaryProvider = process.env.AI_PROVIDER || aiProvider || 'ollama'
  console.info(JSON.stringify({
    event: 'chat_request_started',
    requestId,
    primaryProvider,
  }))

  const passThrough = new PassThrough()
  const requestController = new AbortController()
  const startedAt = Date.now()
  let deadline: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  passThrough.on('close', () => {
    clearInterval(heartbeat)
    clearTimeout(deadline)
    if (!passThrough.writableEnded) {
      requestController.abort()
      console.info(JSON.stringify({ event: 'chat_request_finished', requestId, status: 'disconnected' }))
    }
  })

  passThrough.write(': connected\n\n')
  heartbeat = setInterval(() => {
    if (!requestController.signal.aborted && !passThrough.destroyed) {
      passThrough.write(': keepalive\n\n')
    }
  }, 15_000)
  heartbeat.unref()

  const sendEvent = (eventType: string, data: any) => {
    if (requestController.signal.aborted || passThrough.destroyed || passThrough.writableEnded) return
    passThrough.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const endStream = () => {
    clearInterval(heartbeat)
    clearTimeout(deadline)
    if (!passThrough.writableEnded && !passThrough.destroyed) passThrough.end()
  }

  // Production logs show a 30s streaming limit. This covers orchestration and
  // both providers together, even if an upstream stream does not settle on abort.
  deadline = setTimeout(() => {
    sendEvent('error', {
      code: 'request_timeout',
      requestId,
      message: 'The AI providers did not complete within the response time limit. Please retry your message.',
    })
    console.warn(JSON.stringify({ event: 'chat_request_finished', requestId, status: 'failed', errorCategory: 'timeout', durationMs: Date.now() - startedAt }))
    endStream()
    requestController.abort(new DOMException('Chat request deadline exceeded.', 'TimeoutError'))
  }, 25_000)
  deadline.unref()

  void (async () => {
    try {
      const result = await orchestrateChat(
        {
          requestId,
          prompt,
          history,
          searchMode,
          reasoningMode,
          aiProvider: process.env.AI_PROVIDER || aiProvider,
          modelName: modelName || process.env.OLLAMA_MODEL,
          ollamaBaseUrl: process.env.AI_API_BASE_URL || process.env.OLLAMA_BASE_URL || ollamaBaseUrl,
          ollamaModel: process.env.OLLAMA_MODEL || ollamaModel,
          geminiApiKey,
          openaiApiKey,
          groqApiKey,
          authUser,
          signal: requestController.signal,
        },
        {
          onMemorySaved: (memory) => sendEvent('memory_saved', memory),
          onSearchStart: (data) => sendEvent('search_start', data),
          onSearchStatus: (data) => sendEvent('search_status', data),
          onSearchResults: (evidence) => sendEvent('search_results', evidence),
          onImageSearchResults: (evidence) => sendEvent('image_search_results', evidence),
          onProviderFallback: (data) => sendEvent('provider_fallback', data),
          onToken: (token) => sendEvent('token', { token }),
          onDone: (data) => sendEvent('done', data),
        }
      )
      if (requestController.signal.aborted) return
      console.info(JSON.stringify({
        event: 'chat_request_finished',
        requestId,
        provider: result.provider || primaryProvider,
        model: result.model || '',
        status: 'success',
        durationMs: Date.now() - startedAt,
      }))
      endStream()
    } catch (err: any) {
      if (requestController.signal.aborted) return
      console.error(JSON.stringify({
        event: 'chat_request_finished',
        requestId,
        errorCategory: err?.name === 'TimeoutError' ? 'timeout' : 'request_error',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        ...(err?.status ? { httpStatus: err.status } : {}),
      }))
      sendEvent('error', {
        code: err?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_error',
        requestId,
        ...(err?.status ? { status: err.status } : {}),
        message: err.message || 'An error occurred during response generation.',
      })
      endStream()
    }
  })()

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-ID': requestId,
    },
    body: passThrough,
  }
}

export const handler = stream(handleChatStream)
