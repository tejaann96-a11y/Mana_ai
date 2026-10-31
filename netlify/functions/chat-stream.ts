import { stream } from '@netlify/functions'
import { PassThrough } from 'node:stream'
import { connectLambda } from '@netlify/blobs'
import { orchestrateChat } from '../../server/services/chatOrchestrator.js'
import { authService } from '../../server/services/authService.js'

export const handler = stream(async (event, _context) => {
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

  if (!prompt || typeof prompt !== 'string') {
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

  const passThrough = new PassThrough()
  const requestController = new AbortController()
  let startOutput!: () => void
  const outputReady = new Promise<void>((resolve) => {
    startOutput = resolve
  })
  passThrough.on('close', () => {
    if (!passThrough.writableEnded) requestController.abort()
    startOutput()
  })

  let outputStarted = false
  const pendingEvents: string[] = []
  const sendEvent = (eventType: string, data: any) => {
    if (requestController.signal.aborted || passThrough.destroyed) return
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
    if (!outputStarted && eventType !== 'token' && eventType !== 'error' && eventType !== 'done') {
      pendingEvents.push(payload)
      return
    }
    if (!outputStarted) {
      outputStarted = true
      startOutput()
      for (const queuedEvent of pendingEvents) passThrough.write(queuedEvent)
      pendingEvents.length = 0
    }
    passThrough.write(payload)
  }

    ; (async () => {
      try {
        await orchestrateChat(
          {
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
            onDone: (data) => {
              sendEvent('done', data)
              passThrough.end()
            },
          }
        )
      } catch (err: any) {
        if (requestController.signal.aborted) return
        sendEvent('error', {
          message: err.message || 'An error occurred during response generation.',
        })
        passThrough.end()
      }
    })()

  await outputReady

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    body: passThrough,
  }
})
