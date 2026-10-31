import assert from 'node:assert/strict'
import { configService } from '../server/services/configService.js'
import { generateAIResponse } from '../server/services/aiService.js'
import { generateAIImage } from '../server/services/imageService.js'
import { startVideoJob } from '../server/services/videoService.js'

process.env.NODE_ENV = 'test'
delete process.env.AI_PROVIDER

async function main() {
  const requests: string[] = []
  const originalFetch = globalThis.fetch
  const originalConfig = configService.getConfig()
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    throw new Error('Network access blocked by local-only test.')
  }

  try {
    const config = configService.updateConfig({
      aiProvider: 'builtin',
      imageProvider: 'comfyui',
      comfyuiBaseUrl: 'http://127.0.0.1:1',
    })
    const response = await generateAIResponse({
      prompt: 'Tell me something interesting',
      config,
    })
    assert.match(response, /octopus|ఆక్టోపస్/i)
    assert.equal(requests.length, 0, 'Built-in chat must not make network requests.')

    await assert.rejects(
      generateAIImage({ prompt: 'a small blue flower' }),
      /Cannot reach ComfyUI/
    )
    assert.equal(requests.length, 1, 'Image generation should only check local ComfyUI.')
    assert.match(requests[0], /^http:\/\/127\.0\.0\.1:1\//)

    await assert.rejects(
      startVideoJob({ prompt: 'a short sunset over the ocean' }),
      /no cloud video provider was contacted/
    )
    assert.equal(requests.length, 1, 'Unavailable local video generation must not contact a cloud provider.')

    console.log('Local-only checks passed: built-in chat stayed offline and media errors did not fall back to cloud providers.')
  } finally {
    globalThis.fetch = originalFetch
    configService.updateConfig(originalConfig)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
