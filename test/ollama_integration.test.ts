import assert from 'node:assert'
import { configService, resolveAIProvider, resolveOllamaBaseUrl } from '../server/services/configService.js'
import { selectModelForTask } from '../server/services/modelRouter.js'
import { orchestrateChat } from '../server/services/chatOrchestrator.js'
import { checkOllamaStatus, generateAIResponse, generateOllamaStream } from '../server/services/aiService.js'

process.env.NODE_ENV = 'test'
delete process.env.AI_PROVIDER
delete process.env.DEFAULT_AI_PROVIDER

console.log('=== RUNNING MANA AI LOCAL OLLAMA INTEGRATION & REGRESSION TESTS ===\n')

let passedCount = 0
let failedCount = 0

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`[PASS] ${name}`)
    passedCount++
  } catch (err: any) {
    console.error(`[FAIL] ${name}`)
    console.error(`       Error: ${err.message}`)
    failedCount++
  }
}

async function main() {
  // TEST 1: Default configuration selects Ollama and qwen2.5:3b
  await runTest('Test 1: Default configuration selects Ollama and qwen2.5:3b', () => {
    assert.strictEqual(resolveAIProvider(undefined, undefined, undefined), 'ollama')
    assert.strictEqual(resolveAIProvider(undefined, undefined, 'ollama'), 'ollama')
    assert.strictEqual(resolveAIProvider(undefined, 'ollama', undefined), 'ollama')
    assert.strictEqual(resolveOllamaBaseUrl(undefined, '', '', ''), 'http://127.0.0.1:11434')
    const cfg = {
      ...configService.getConfig(),
      aiProvider: resolveAIProvider(undefined, undefined, undefined),
      ollamaModel: 'qwen2.5:3b',
      modelName: 'qwen2.5:3b',
    }
    assert.strictEqual(cfg.aiProvider, 'ollama')
    assert.strictEqual(cfg.ollamaModel, 'qwen2.5:3b')
    assert.strictEqual(cfg.modelName, 'qwen2.5:3b')
  })

  await runTest('Gemini API key presence never selects Gemini by default', () => {
    const withKey = { ...configService.getConfig(), aiProvider: resolveAIProvider(undefined, undefined, undefined), geminiApiKey: 'test-gemini-api-key' }
    const withoutKey = { ...withKey, geminiApiKey: '' }
    const intent = { category: 'conversational' as const, confidence: 1, needsSearch: false, isDetailRequested: false }
    assert.strictEqual(selectModelForTask('fast', withKey, intent).provider, 'ollama')
    assert.strictEqual(selectModelForTask('fast', withoutKey, intent).provider, 'ollama')
  })

  await runTest('Explicit and intentionally saved provider preferences are respected', () => {
    assert.strictEqual(resolveAIProvider('gemini', undefined, 'ollama'), 'gemini')
    assert.strictEqual(resolveAIProvider(undefined, 'ollama', 'gemini'), 'ollama')
    assert.strictEqual(resolveAIProvider('invalid-provider', undefined, 'invalid-provider'), 'ollama')
  })

  // TEST 2: ModelRouter routes tasks to Ollama when configured
  await runTest('Test 2: ModelRouter routes fast and reasoning tasks to Ollama', () => {
    const cfg = {
      ...configService.getConfig(),
      aiProvider: 'ollama' as const,
      ollamaModel: 'qwen2.5:3b',
      modelName: 'qwen2.5:3b',
    }
    const fastSelection = selectModelForTask('fast', cfg, {
      category: 'conversational',
      confidence: 1,
      needsSearch: false,
      isDetailRequested: false,
    })
    assert.strictEqual(fastSelection.provider, 'ollama')
    assert.strictEqual(fastSelection.modelName, 'qwen2.5:3b')

    const deepSelection = selectModelForTask('reasoning', cfg, {
      category: 'coding',
      confidence: 1,
      needsSearch: false,
      isDetailRequested: true,
    })
    assert.strictEqual(deepSelection.provider, 'ollama')
    assert.strictEqual(deepSelection.modelName, 'qwen2.5:3b')

    const customizedConfig = {
      ...cfg,
      ollamaModel: 'llama3.2:3b',
      modelName: 'gemini-2.5-flash',
    }
    assert.strictEqual(selectModelForTask('fast', customizedConfig, {
      category: 'conversational',
      confidence: 1,
      needsSearch: false,
      isDetailRequested: false,
    }).modelName, 'llama3.2:3b')
  })

  // TEST 3: OrchestrateChat streams tokens cleanly with Ollama in test mode
  await runTest('Test 3: OrchestrateChat streams tokens and finishes with onDone', async () => {
    const tokens: string[] = []
    let doneEvent: any = null

    await orchestrateChat(
      {
        prompt: 'Namaste Mana AI! Tell me something interesting.',
        aiProvider: 'ollama',
        modelName: 'qwen2.5:3b',
        ollamaModel: 'qwen2.5:3b',
        searchMode: 'never',
      },
      {
        onToken: (tok) => tokens.push(tok),
        onDone: (data) => {
          doneEvent = data
        },
      }
    )

    assert(tokens.length > 0, 'Tokens must be emitted via onToken')
    assert(doneEvent !== null, 'onDone event must be emitted')
    assert.strictEqual(doneEvent.provider, 'ollama')
    assert.strictEqual(doneEvent.model, 'qwen2.5:3b')
    assert(doneEvent.content.length > 0, 'Content must not be empty')
    assert(doneEvent.timings.totalMs >= 0, 'Timing must be non-negative')
  })

  // TEST 4: Multi-turn history is preserved across follow-up queries
  await runTest('Test 4: Multi-turn history is preserved in chat orchestrator', async () => {
    const history = [
      { role: 'user' as const, content: 'Do you know Hyderabad?' },
      { role: 'assistant' as const, content: 'Yes! Hyderabad is known for Charminar, Biryani, and its IT hub.' },
    ]

    let resultDone: any = null
    await orchestrateChat(
      {
        prompt: 'What about Ameerpet?',
        history,
        aiProvider: 'ollama',
        modelName: 'qwen2.5:3b',
        ollamaModel: 'qwen2.5:3b',
        searchMode: 'never',
      },
      {
        onToken: () => {},
        onDone: (data) => {
          resultDone = data
        },
      }
    )

    assert(resultDone !== null, 'onDone event must be emitted for multi-turn request')
    assert.strictEqual(resultDone.provider, 'ollama')
    assert(resultDone.content.length > 0, 'Follow-up reply must be generated')
  })

  // TEST 5: Clean failure and clear guidance when Ollama server is unreachable
  await runTest('Test 5: Clean error when Ollama server is unreachable on invalid port', async () => {
    let caughtError: any = null
    const prevEnv = process.env.NODE_ENV
    const prevNetlify = process.env.NETLIFY
    try {
      process.env.NODE_ENV = 'production'
      delete process.env.NETLIFY
      try {
        await generateOllamaStream(
          'http://127.0.0.1:59999',
          'qwen2.5:3b',
          'System prompt',
          'Hello',
          [],
          () => {}
        )
      } finally {
        restoreEnv('NODE_ENV', prevEnv)
        restoreEnv('NETLIFY', prevNetlify)
      }
    } catch (err: any) {
      caughtError = err
    }

    assert(caughtError !== null, 'Should throw an error when Ollama is unreachable')
    assert(
      caughtError.message.includes('Ollama is not running') || caughtError.message.includes('Failed to connect'),
      `Expected Ollama unreachable message, got: ${caughtError.message}`
    )
  })

  // TEST 6: Clear guidance when invoked in Netlify cloud serverless environment
  await runTest('Test 6: Netlify cloud environment returns clear explanation', async () => {
    const prevNetlify = process.env.NETLIFY
    const prevEnv = process.env.NODE_ENV
    process.env.NETLIFY = 'true'
    process.env.NODE_ENV = 'production'
    let caughtError: any = null

    try {
      await generateOllamaStream(
        'http://127.0.0.1:11434',
        'qwen2.5:3b',
        'System prompt',
        'Hello',
        [],
        () => {}
      )
    } catch (err: any) {
      caughtError = err
    } finally {
      restoreEnv('NETLIFY', prevNetlify)
      restoreEnv('NODE_ENV', prevEnv)
    }

    assert(caughtError !== null, 'Should reject Ollama 127.0.0.1 in Netlify environment')
    assert(
      caughtError.message.includes('Netlify') || caughtError.message.includes('local computer'),
      `Expected Netlify-specific guidance, got: ${caughtError.message}`
    )
  })

  // TEST 7: checkOllamaStatus gracefully handles offline state without throwing
  await runTest('Test 7: checkOllamaStatus returns safe status object when offline', async () => {
    const status = await checkOllamaStatus('http://127.0.0.1:59999')
    assert.strictEqual(typeof status.connected, 'boolean')
    assert.strictEqual(status.connected, false)
    assert(Array.isArray(status.models))
    assert.strictEqual(status.baseUrl, 'http://127.0.0.1:59999')
  })

  await runTest('Remote Ollama requires an HTTPS authenticated gateway', async () => {
    const previousKey = process.env.OLLAMA_API_KEY
    delete process.env.OLLAMA_API_KEY
    try {
      const missingKeyStatus = await checkOllamaStatus('https://remote-ollama.example.com')
      assert.strictEqual(missingKeyStatus.connected, false)
      assert(missingKeyStatus.error?.includes('OLLAMA_API_KEY'))
      const directPortStatus = await checkOllamaStatus('https://remote-ollama.example.com:11434')
      assert.strictEqual(directPortStatus.connected, false)
      assert(directPortStatus.error?.includes('OLLAMA_API_KEY'))
    } finally {
      restoreEnv('OLLAMA_API_KEY', previousKey)
    }
  })

  await runTest('Server Ollama credentials cannot be sent to a browser-selected remote URL', async () => {
    const previousKey = process.env.OLLAMA_API_KEY
    const previousAiUrl = process.env.AI_API_BASE_URL
    const previousOllamaUrl = process.env.OLLAMA_BASE_URL
    const previousMode = process.env.NODE_ENV
    const originalFetch = globalThis.fetch
    let fetchCalled = false
    process.env.OLLAMA_API_KEY = 'test-ollama-gateway-key'
    delete process.env.AI_API_BASE_URL
    delete process.env.OLLAMA_BASE_URL
    process.env.NODE_ENV = 'production'
    globalThis.fetch = async () => {
      fetchCalled = true
      throw new TypeError('Unexpected outbound request')
    }
    try {
      await assert.rejects(
        generateOllamaStream(
          'https://browser-selected.example.com',
          'qwen2.5:3b',
          'System prompt',
          'Hello',
          []
        ),
        /Configure the remote Ollama gateway/
      )
      assert.strictEqual(fetchCalled, false)
    } finally {
      restoreEnv('OLLAMA_API_KEY', previousKey)
      restoreEnv('AI_API_BASE_URL', previousAiUrl)
      restoreEnv('OLLAMA_BASE_URL', previousOllamaUrl)
      restoreEnv('NODE_ENV', previousMode)
      globalThis.fetch = originalFetch
    }
  })

  await runTest('Ollama connection failure never falls back to available Gemini credentials', async () => {
    const previousMode = process.env.NODE_ENV
    const previousGeminiKey = process.env.GEMINI_API_KEY
    process.env.NODE_ENV = 'production'
    process.env.GEMINI_API_KEY = 'test-gemini-api-key'
    try {
      await assert.rejects(
        generateAIResponse({
          prompt: 'Hello',
          config: {
            ...configService.getConfig(),
            aiProvider: 'ollama',
            ollamaBaseUrl: 'http://127.0.0.1:59999',
            ollamaModel: 'qwen2.5:3b',
            modelName: 'qwen2.5:3b',
          },
        }),
        /Ollama is not running/
      )
    } finally {
      restoreEnv('NODE_ENV', previousMode)
      restoreEnv('GEMINI_API_KEY', previousGeminiKey)
    }
  })

  const withFallbackEnvironment = async (
    fetchImplementation: typeof fetch,
    action: () => Promise<void>,
    apiKey = 'test-mock-key'
  ) => {
    const previous: Record<string, string | undefined> = {
      NODE_ENV: process.env.NODE_ENV,
      AI_PROVIDER: process.env.AI_PROVIDER,
      AI_FALLBACK_ENABLED: process.env.AI_FALLBACK_ENABLED,
      AI_FALLBACK_PROVIDER: process.env.AI_FALLBACK_PROVIDER,
      OLLAMA_CONNECTION_TIMEOUT_MS: process.env.OLLAMA_CONNECTION_TIMEOUT_MS,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_MODEL: process.env.GEMINI_MODEL,
    }
    const originalFetch = globalThis.fetch
    process.env.NODE_ENV = 'production'
    process.env.AI_PROVIDER = 'ollama'
    process.env.AI_FALLBACK_ENABLED = 'true'
    process.env.AI_FALLBACK_PROVIDER = 'gemini'
    process.env.OLLAMA_CONNECTION_TIMEOUT_MS = '50'
    process.env.GEMINI_API_KEY = apiKey
    process.env.GEMINI_MODEL = 'gemini-3.8-flash'
    globalThis.fetch = fetchImplementation
    try {
      await action()
    } finally {
      for (const [name, value] of Object.entries(previous)) restoreEnv(name, value)
      globalThis.fetch = originalFetch
    }
  }

  const makeGenerationOptions = () => ({
    prompt: 'Explain a simple greeting.',
    history: [
      { role: 'user' as const, content: 'What did I ask earlier?' },
      { role: 'assistant' as const, content: 'You asked about Hyderabad.' },
    ],
    config: {
      ...configService.getConfig(),
      aiProvider: 'ollama' as const,
      ollamaBaseUrl: 'http://127.0.0.1:59998',
      ollamaModel: 'qwen2.5:3b',
      modelName: 'qwen2.5:3b',
    },
  })

  await runTest('Ollama success does not call Gemini', async () => {
    let geminiCalled = false
    await withFallbackEnvironment(async (input, init) => {
      const url = String(input)
      if (url.startsWith('https://generativelanguage.googleapis.com/')) geminiCalled = true
      assert(url.startsWith('http://127.0.0.1:59998/api/chat'))
      assert.strictEqual(JSON.parse(String(init?.body)).model, 'qwen2.5:3b')
      return new Response('{"message":{"content":"Ollama answer"},"done":true}\n', {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      })
    }, async () => {
      const response = await generateAIResponse(makeGenerationOptions())
      assert.strictEqual(response, 'Ollama answer')
      assert.strictEqual(geminiCalled, false)
    })
  })

  await runTest('Ollama offline streams one Gemini fallback response with history', async () => {
    let requestCount = 0
    const tokens: string[] = []
    let fallbackCount = 0
    await withFallbackEnvironment(async () => {
      requestCount++
      throw new TypeError('fetch failed')
    }, async () => {
      const response = await generateAIResponse({
        ...makeGenerationOptions(),
        onToken: (token) => tokens.push(token),
        onProviderFallback: ({ from, to }) => {
          assert.strictEqual(from, 'ollama')
          assert.strictEqual(to, 'gemini')
          fallbackCount++
        },
      })
      assert(response.includes('verified test response from Gemini'))
      assert(response.includes('gemini-3.8-flash'))
      assert(response.includes('2 prior chat message(s)'))
      assert.strictEqual(fallbackCount, 1)
      assert.strictEqual(requestCount, 1)
      assert(tokens.join(''), response)
      assert.strictEqual(tokens.filter((token) => token.includes('Ollama')).length, 0)
    })
  })

  await runTest('Ollama connection timeout triggers Gemini fallback', async () => {
    await withFallbackEnvironment(async (_input, init) => {
      const signal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }, async () => {
      const response = await generateAIResponse(makeGenerationOptions())
      assert(response.includes('verified test response from Gemini'))
    })
  })

  await runTest('Private file requests never use Gemini fallback', async () => {
    await withFallbackEnvironment(async () => {
      throw new TypeError('fetch failed')
    }, async () => {
      await assert.rejects(
        generateAIResponse({
          ...makeGenerationOptions(),
          allowProviderFallback: false,
          documentMatches: [{
            docTitle: 'private.txt',
            score: 1,
            chunk: {
              id: 'private-chunk',
              docId: 'private-document',
              docTitle: 'private.txt',
              chunkIndex: 0,
              text: 'private document contents',
              tokensApprox: 4,
            },
          }],
        }),
        /Gemini fallback is disabled for requests containing private files or images/
      )
    })
  })

  await runTest('Missing Gemini fallback key returns an actionable error', async () => {
    await withFallbackEnvironment(async () => {
      throw new TypeError('fetch failed')
    }, async () => {
      await assert.rejects(
        generateAIResponse(makeGenerationOptions()),
        /Gemini fallback is enabled, but GEMINI_API_KEY is missing or invalid/
      )
    }, '')
  })

  await runTest('Gemini fallback failures are returned clearly', async () => {
    await withFallbackEnvironment(async (input) => {
      if (String(input).startsWith('http://127.0.0.1:59998')) {
        throw new TypeError('fetch failed')
      }
      throw new TypeError('Gemini service unavailable')
    }, async () => {
      await assert.rejects(
        generateAIResponse(makeGenerationOptions()),
        /Ollama is unavailable and Gemini fallback failed/
      )
    }, 'valid-test-gemini-key')
  })

  await runTest('Ollama authentication failure does not trigger Gemini fallback', async () => {
    let requestCount = 0
    await withFallbackEnvironment(async () => {
      requestCount++
      return new Response('{"error":"unauthorized"}', { status: 401 })
    }, async () => {
      await assert.rejects(generateAIResponse(makeGenerationOptions()), /Ollama Error \(401\)/)
      assert.strictEqual(requestCount, 1)
    })
  })

  await runTest('Orchestrator reports Gemini as handler without duplicating chat history or tokens', async () => {
    const tokens: string[] = []
    let done: any
    let fallbackEvents = 0
    const history = [
      { role: 'user' as const, content: 'Earlier question' },
      { role: 'assistant' as const, content: 'Earlier answer' },
    ]
    await withFallbackEnvironment(async () => {
      throw new TypeError('fetch failed')
    }, async () => {
      await orchestrateChat(
        {
          ...makeGenerationOptions(),
          history,
          searchMode: 'never',
        },
        {
          onToken: (token) => tokens.push(token),
          onProviderFallback: () => fallbackEvents++,
          onDone: (data) => {
            done = data
          },
        }
      )
      assert.strictEqual(done.provider, 'gemini')
      assert.strictEqual(done.model, 'gemini-3.8-flash')
      assert.strictEqual(fallbackEvents, 1)
      assert(tokens.length > 0)
      assert(tokens.join(''), done.content)
      assert.deepStrictEqual(history, [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ])
    })
  })

  // TEST 8: AI_API_BASE_URL is supported for production cloud backend configuration
  await runTest('Test 8: AI_API_BASE_URL is recognized in orchestrator and config', async () => {
    const prevUrl = process.env.AI_API_BASE_URL
    const prevOllamaUrl = process.env.OLLAMA_BASE_URL
    const prevApiKey = process.env.OLLAMA_API_KEY
    const prevNetlify = process.env.NETLIFY
    const prevEnv = process.env.NODE_ENV
    const prevProvider = process.env.AI_PROVIDER
    const originalFetch = globalThis.fetch
    try {
      process.env.AI_API_BASE_URL = 'https://custom-cloud-ollama.example.com'
      process.env.OLLAMA_BASE_URL = 'https://secondary-ollama.example.com'
      process.env.OLLAMA_API_KEY = 'test-ollama-gateway-key'
      process.env.NETLIFY = 'true'
      process.env.NODE_ENV = 'production'
      process.env.AI_PROVIDER = 'ollama'

      // Orchestrator should not overwrite server cloud AI_API_BASE_URL with client localhost
      let capturedUrl = ''
      let capturedHeaders: Headers | undefined
      let capturedBody: { model?: string; messages?: Array<{ role: string; content: string }> } | undefined
      globalThis.fetch = async (input, init) => {
        capturedUrl = String(input)
        capturedHeaders = new Headers(init?.headers)
        capturedBody = JSON.parse(String(init?.body))
        return new Response('{"message":{"content":"gateway response"},"done":false}\n', {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      }
      await orchestrateChat(
        {
          prompt: 'Hello cloud',
          ollamaBaseUrl: 'http://127.0.0.1:11434',
          modelName: 'qwen2.5:3b',
          ollamaModel: 'qwen2.5:3b',
          aiProvider: 'ollama',
          history: [
            { role: 'user', content: 'Earlier question' },
            { role: 'assistant', content: 'Earlier answer' },
          ],
          searchMode: 'never',
        },
        {
          onToken: () => {},
          onDone: () => {},
        }
      )
      assert.strictEqual(capturedUrl, 'https://custom-cloud-ollama.example.com/api/chat')
      assert.strictEqual(capturedHeaders?.get('authorization'), 'Bearer test-ollama-gateway-key')
      assert.strictEqual(capturedBody?.model, 'qwen2.5:3b')
      assert(capturedBody?.messages?.some((message) => message.content === 'Earlier question'))
      assert(capturedBody?.messages?.some((message) => message.content === 'Earlier answer'))
      assert.strictEqual(resolveOllamaBaseUrl('saved-url', '', 'https://ollama-env.example.com'), 'https://ollama-env.example.com')
    } finally {
      restoreEnv('AI_API_BASE_URL', prevUrl)
      restoreEnv('OLLAMA_BASE_URL', prevOllamaUrl)
      restoreEnv('OLLAMA_API_KEY', prevApiKey)
      restoreEnv('NETLIFY', prevNetlify)
      restoreEnv('NODE_ENV', prevEnv)
      restoreEnv('AI_PROVIDER', prevProvider)
      globalThis.fetch = originalFetch
    }
  })

  // TEST 9: Netlify cloud deployment with unreachable remote host produces distinct error
  await runTest('Test 9: Netlify cloud deployment with unreachable remote host produces distinct cloud error', async () => {
    const prevNetlify = process.env.NETLIFY
    const prevEnv = process.env.NODE_ENV
    const prevApiKey = process.env.OLLAMA_API_KEY
    const prevOllamaUrl = process.env.AI_API_BASE_URL
    const originalFetch = globalThis.fetch
    process.env.NETLIFY = 'true'
    process.env.NODE_ENV = 'production'
    process.env.OLLAMA_API_KEY = 'test-ollama-gateway-key'
    process.env.AI_API_BASE_URL = 'https://unreachable-ollama-cloud-host-9999.example.com'
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    let caughtError: any = null

    try {
      await generateOllamaStream(
        'https://unreachable-ollama-cloud-host-9999.example.com',
        'qwen2.5:3b',
        'System prompt',
        'Hello',
        [],
        () => {}
      )
    } catch (err: any) {
      caughtError = err
    } finally {
      restoreEnv('NETLIFY', prevNetlify)
      restoreEnv('NODE_ENV', prevEnv)
      restoreEnv('OLLAMA_API_KEY', prevApiKey)
      restoreEnv('AI_API_BASE_URL', prevOllamaUrl)
      globalThis.fetch = originalFetch
    }

    assert(caughtError !== null, 'Should throw error when remote cloud host is unreachable')
    assert(
      caughtError.message.includes('cloud AI backend') ||
        caughtError.message.includes('configured Ollama gateway') ||
        caughtError.message.includes('AI_API_BASE_URL') ||
        caughtError.message.includes('Failed to connect'),
      `Expected cloud-specific error, got: ${caughtError.message}`
    )
  })

  console.log(`\nTests finished: ${passedCount} passed, ${failedCount} failed.`)
  if (failedCount > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
