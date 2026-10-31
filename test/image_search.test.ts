import assert from 'node:assert/strict'
import { configService } from '../server/services/configService.js'
import { orchestrateChat } from '../server/services/chatOrchestrator.js'
import { executeImageSearch, extractImageSearchQuery } from '../server/services/imageSearchService.js'

async function main() {
  const originalFetch = globalThis.fetch
  const originalConfig = configService.getConfig()
  const requests: string[] = []

  assert.equal(extractImageSearchQuery('Show me Prabhas photos'), 'Prabhas')
  assert.equal(extractImageSearchQuery('Show me a photograph of Prabhas'), 'Prabhas')
  assert.equal(extractImageSearchQuery('Do you have pictures of elephants?'), 'elephants')
  assert.equal(extractImageSearchQuery('Find pictures of elephants'), 'elephants')
  assert.equal(extractImageSearchQuery('Can you show me Prabhas photos?'), 'Prabhas')
  assert.equal(extractImageSearchQuery('Image search for Taj Mahal'), 'Taj Mahal')
  assert.equal(extractImageSearchQuery('Generate an image of an elephant'), null)
  assert.equal(extractImageSearchQuery('Draw a picture of a red car'), null)

  try {
    configService.updateConfig({
      aiProvider: 'builtin',
      searchProvider: 'duckduckgo',
      searchMode: 'auto',
    })
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push(url)
      if (url.startsWith('https://duckduckgo.com/?')) {
        return new Response('var vqd="test-image-token";', { status: 200 })
      }
      if (url.startsWith('https://duckduckgo.com/i.js?')) {
        return Response.json({
          results: [
            {
              title: 'Prabhas at a film event',
              image: 'https://images.example.test/prabhas.jpg',
              thumbnail: 'https://thumbs.example.test/prabhas.jpg',
              url: 'https://photography.example.test/prabhas-event',
              license: 'provider-reported',
            },
            {
              title: 'Restricted local image',
              image: 'http://127.0.0.1/private.jpg',
              thumbnail: 'http://127.0.0.1/private.jpg',
              url: 'https://example.test/page',
            },
            {
              title: 'Unsafe image scheme',
              image: 'javascript:alert(1)',
              thumbnail: 'javascript:alert(1)',
              url: 'https://example.test/unsafe',
            },
          ],
        })
      }
      throw new Error(`Unexpected outbound request: ${url}`)
    }

    let emittedEvidence: unknown
    const result = await orchestrateChat({
      prompt: 'Show me Prabhas photos',
      searchMode: 'auto',
      aiProvider: 'builtin',
    }, {
      onImageSearchResults: (evidence) => { emittedEvidence = evidence },
    })
    assert.equal(result.isSearchPerformed, true)
    assert.match(result.content, /existing web images, not AI-generated/)
    assert.equal(result.imageSearchEvidence?.results.length, 1)
    assert.equal(result.imageSearchEvidence?.results[0].sourceDomain, 'photography.example.test')
    assert.equal(result.imageSearchEvidence?.results[0].imageUrl, 'https://images.example.test/prabhas.jpg')
    assert.equal(emittedEvidence, result.imageSearchEvidence, 'Image results must be available to the streaming route.')
    assert.equal(requests.length, 2)

    requests.length = 0
    const noSearch = await orchestrateChat({
      prompt: 'Show me Prabhas photos',
      searchMode: 'never',
      aiProvider: 'builtin',
    })
    assert.equal(noSearch.isSearchPerformed, false)
    assert.match(noSearch.content, /Web search is off/)
    assert.equal(requests.length, 0, 'Search Off must not contact a search or image host.')

    configService.updateConfig({
      aiProvider: 'builtin',
      searchProvider: 'brave',
      searchMode: 'auto',
      braveApiKey: 'brave-test-key-123456',
    })
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push(url)
      assert.equal(url, 'https://api.search.brave.com/res/v1/images/search?q=Prabhas&count=8')
      assert.equal(new Headers(init?.headers).get('X-Subscription-Token'), 'brave-test-key-123456')
      return Response.json({
        results: [
          {
            title: 'Prabhas portrait',
            url: 'https://news.example.test/prabhas',
            properties: { url: 'https://cdn.example.test/prabhas-full.jpg' },
            thumbnail: { src: 'https://cdn.example.test/prabhas-thumb.jpg' },
          },
        ],
      })
    }
    const braveEvidence = await executeImageSearch(
      'Prabhas',
      'brave',
      { brave: 'brave-test-key-123456' }
    )
    assert.equal(braveEvidence.provider, 'brave')
    assert.equal(braveEvidence.results[0].sourceDomain, 'news.example.test')
    assert.equal(requests.length, 1)

    globalThis.fetch = async () => { throw new Error('Provider unavailable') }
    const unavailable = await executeImageSearch(
      'unique unavailable image query',
      'duckduckgo',
      {},
    )
    assert.equal(unavailable.results.length, 0)
    assert.match(unavailable.errorMessage || '', /Image search is unavailable/)

    console.log('Image search checks passed: real-provider routing, attribution, unsafe URL filtering, generation separation, and Search Off privacy.')
  } finally {
    globalThis.fetch = originalFetch
    configService.updateConfig(originalConfig)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
