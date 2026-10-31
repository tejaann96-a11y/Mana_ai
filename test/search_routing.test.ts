import assert from 'node:assert/strict'
import { classifyIntent } from '../server/services/intentClassifier.js'
import { orchestrateChat } from '../server/services/chatOrchestrator.js'
import { configService } from '../server/services/configService.js'
import { executeWebSearch } from '../server/services/searchService.js'

async function main() {
  const liveQueries = [
    'How much is the iPhone 15 today?',
    'What is the latest technology news?',
    'What is the current weather in Hyderabad?',
    'Who won the match today?',
    'What is the latest Python version?',
    'Is Acme Corporation hiring?',
    'Compare the iPhone 16 and Galaxy S25.',
  ]
  for (const prompt of liveQueries) {
    assert.equal(classifyIntent(prompt).needsSearch, true, `Expected live search routing for: ${prompt}`)
  }

  assert.equal(classifyIntent('Explain artificial intelligence').needsSearch, false)
  assert.equal(classifyIntent('What is 17 times 23?').needsSearch, false)
  assert.equal(classifyIntent('What is the weather today?').category, 'clarification')
  assert.equal(classifyIntent('weather forecast for tomorrow').needsSearch, false)

  const followup = classifyIntent('What about its price?', [
    { role: 'user', content: 'Tell me about the Pixel 10.' },
    { role: 'assistant', content: 'The Pixel 10 is a Google phone.' },
  ])
  assert.equal(followup.needsSearch, true)
  assert.match(followup.refinedQuery, /Pixel 10/i)

  const originalFetch = globalThis.fetch
  const originalConfig = configService.getConfig()
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    if (url !== 'https://lite.duckduckgo.com/lite/') {
      throw new Error(`Unexpected external request: ${url}`)
    }
    return new Response(
      '<table><tr><td><a class="result-link" href="https://store.example.test/iphone">iPhone 15 price today</a></td></tr><tr><td><a class="result-snippet">The listed iPhone 15 price is ₹49,999 at the store today.</a></td></tr><tr><td><a class="result-link" href="https://badreuters.com/story">Independent article</a></td></tr><tr><td><a class="result-snippet">This result comes from a similarly named but unrelated domain.</a></td></tr></table>',
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    )
  }

  try {
    const config = configService.updateConfig({
      aiProvider: 'builtin',
      searchProvider: 'duckduckgo',
      searchMode: 'auto',
    })
    const noSearch = await orchestrateChat({
      prompt: 'What is a Java class?',
      searchMode: 'never',
      aiProvider: 'gemini',
      geminiApiKey: 'test-mock-key',
    })
    assert.equal(noSearch.isSearchPerformed, false)
    assert.equal(requests.length, 0, 'Search Off must not access the network.')

    configService.updateConfig(config)
    const liveResult = await orchestrateChat({
      prompt: 'How much is the iPhone 15 today?',
      searchMode: 'auto',
      aiProvider: 'builtin',
    })
    assert.equal(liveResult.isSearchPerformed, true)
    assert.match(liveResult.content, /₹49,999/)
    assert.match(liveResult.content, /\[store\.example\.test\]\(https:\/\/store\.example\.test\/iphone\)/)
    assert.equal(requests.length, 1, 'Only the current search query should be sent to the configured search route.')

    const qualityEvidence = await executeWebSearch('source domain ranking regression', 'duckduckgo')
    assert.equal(
      qualityEvidence.results.find((result) => result.domain === 'badreuters.com')?.isOfficialOrReputable,
      false,
      'A similarly named domain must not inherit a reputable domain ranking.'
    )

    const searchAbort = new AbortController()
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('Search requests must receive a cancellation signal.'))
          return
        }
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        setTimeout(() => searchAbort.abort(), 0)
      })
    await assert.rejects(
      orchestrateChat({
        prompt: 'What is the current price of the ZZZ-2948 test widget?',
        searchMode: 'auto',
        aiProvider: 'builtin',
        signal: searchAbort.signal,
      }),
      (error: Error) => error.name === 'AbortError'
    )

    const generationAbort = new AbortController()
    configService.updateConfig({
      aiProvider: 'ollama',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen2.5:3b',
    })
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('AI requests must receive a cancellation signal.'))
          return
        }
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        setTimeout(() => generationAbort.abort(), 0)
      })
    await assert.rejects(
      orchestrateChat({
        prompt: 'Explain how a binary search tree works.',
        searchMode: 'never',
        aiProvider: 'ollama',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        ollamaModel: 'qwen2.5:3b',
        signal: generationAbort.signal,
      }),
      (error: Error) => error.name === 'AbortError'
    )

    console.log(`Search routing checks passed (${liveQueries.length} live-information categories, privacy, citations, cancellation).`)
  } finally {
    globalThis.fetch = originalFetch
    configService.updateConfig(originalConfig)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
