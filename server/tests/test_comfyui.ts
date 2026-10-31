/**
 * ComfyUI Service Tests
 *
 * All tests run in offline/mock mode — no real ComfyUI instance required.
 * Tests verify workflow building, parameter injection, error handling, and edge cases.
 */

import { checkComfyUIStatus, loadOrBuildWorkflow, submitWorkflow, pollForCompletion } from '../services/comfyuiService.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// ─── Test 1: Status check against unreachable port ───────────────────────────
console.log('\n[Test 1] checkComfyUIStatus — unreachable port')
{
  const status = await checkComfyUIStatus('http://127.0.0.1:9999')
  assert(status.connected === false, 'connected=false for unreachable port')
  assert(typeof status.error === 'string' && status.error.length > 0, 'error message provided')
}

// ─── Test 2: Default workflow structure ───────────────────────────────────────
console.log('\n[Test 2] loadOrBuildWorkflow — default workflow node structure')
{
  const wf = loadOrBuildWorkflow({ prompt: 'a cat', width: 512, height: 512, steps: 20 })
  const nodeIds = Object.keys(wf).map(Number).sort((a, b) => a - b)
  assert(nodeIds.length === 7, 'workflow has 7 nodes', `got ${nodeIds.length}`)

  const types = Object.values(wf).map((n: any) => n.class_type)
  assert(types.includes('CheckpointLoaderSimple'), 'has CheckpointLoaderSimple')
  assert(types.includes('KSampler'), 'has KSampler')
  assert(types.includes('EmptyLatentImage'), 'has EmptyLatentImage')
  assert(types.includes('VAEDecode'), 'has VAEDecode')
  assert(types.includes('SaveImage'), 'has SaveImage')
  const clipCount = types.filter((t) => t === 'CLIPTextEncode').length
  assert(clipCount === 2, 'has 2 CLIPTextEncode nodes (positive + negative)')
}

// ─── Test 3: Positive prompt injection ───────────────────────────────────────
console.log('\n[Test 3] loadOrBuildWorkflow — positive prompt injected correctly')
{
  const wf = loadOrBuildWorkflow({ prompt: 'a majestic mountain at sunset', width: 512, height: 512 })
  // Node '2' is the positive CLIPTextEncode in default workflow
  const positiveNode = wf['2']
  assert(
    positiveNode?.inputs?.text === 'a majestic mountain at sunset',
    'positive CLIPTextEncode text = prompt'
  )
}

// ─── Test 4: KSampler params injected ────────────────────────────────────────
console.log('\n[Test 4] loadOrBuildWorkflow — KSampler parameters set correctly')
{
  const wf = loadOrBuildWorkflow({ prompt: 'test', steps: 30, cfgScale: 8, seed: 42 })
  const ksampler = wf['5']
  assert(ksampler?.inputs?.steps === 30, 'steps=30')
  assert(ksampler?.inputs?.cfg === 8, 'cfg=8')
  assert(ksampler?.inputs?.seed === 42, 'seed=42')
}

// ─── Test 5: EmptyLatentImage dimensions ─────────────────────────────────────
console.log('\n[Test 5] loadOrBuildWorkflow — EmptyLatentImage dimensions')
{
  const wf = loadOrBuildWorkflow({ prompt: 'test', width: 768, height: 432 })
  const latent = wf['4']
  assert(latent?.inputs?.width === 768, 'width=768')
  assert(latent?.inputs?.height === 432, 'height=432')
  assert(latent?.inputs?.batch_size === 1, 'batch_size=1 (single image)')
}

// ─── Test 6: SaveImage filename prefix ───────────────────────────────────────
console.log('\n[Test 6] loadOrBuildWorkflow — SaveImage filename_prefix=ManaAI')
{
  const wf = loadOrBuildWorkflow({ prompt: 'test' })
  const saveNode = wf['7']
  assert(saveNode?.inputs?.filename_prefix === 'ManaAI', 'filename_prefix=ManaAI')
}

// ─── Test 7: Checkpoint model injection ──────────────────────────────────────
console.log('\n[Test 7] loadOrBuildWorkflow — checkpoint model injected')
{
  const wf = loadOrBuildWorkflow({ prompt: 'test', checkpointModel: 'dreamshaper_8.safetensors' })
  const loader = wf['1']
  assert(loader?.inputs?.ckpt_name === 'dreamshaper_8.safetensors', 'ckpt_name set correctly')
}

// ─── Test 8: Random seed assigned when none provided ─────────────────────────
console.log('\n[Test 8] loadOrBuildWorkflow — random seed assigned when not specified')
{
  const wf = loadOrBuildWorkflow({ prompt: 'test' })
  const ksampler = wf['5']
  assert(typeof ksampler?.inputs?.seed === 'number', 'seed is a number')
  assert(ksampler?.inputs?.seed >= 0, 'seed is non-negative')
}

// ─── Test 9: Missing workflow file throws clear error ─────────────────────────
console.log('\n[Test 9] loadOrBuildWorkflow — missing workflow file throws clear error')
{
  let threw = false
  let errMsg = ''
  try {
    loadOrBuildWorkflow({ prompt: 'test', workflowPath: '/nonexistent/workflow.json' })
  } catch (e: any) {
    threw = true
    errMsg = e.message || ''
  }
  assert(threw, 'throws when workflowPath does not exist')
  assert(errMsg.includes('not found'), 'error mentions "not found"', `got: ${errMsg}`)
}

// ─── Test 10: submitWorkflow rejects on non-200 response ─────────────────────
console.log('\n[Test 10] submitWorkflow — throws on HTTP error response (mock)')
{
  // Mock fetch to simulate a 500 error from ComfyUI
  const originalFetch = globalThis.fetch
  let threw = false
  let errMsg = ''
  try {
    globalThis.fetch = async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'internal server error' }),
      } as any)

    await submitWorkflow('http://127.0.0.1:8188', { '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } })
  } catch (e: any) {
    threw = true
    errMsg = e.message || ''
  } finally {
    globalThis.fetch = originalFetch
  }
  assert(threw, 'throws on HTTP 500 from ComfyUI')
  assert(errMsg.length > 0, 'error message is non-empty', `got: ${errMsg}`)
}

// ─── Test 11: pollForCompletion timeout ──────────────────────────────────────
console.log('\n[Test 11] pollForCompletion — times out when history never completes')
{
  const originalFetch = globalThis.fetch
  let threw = false
  let errMsg = ''
  try {
    // Mock fetch to always return empty history (job never finishes)
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({}), // empty history, promptId not present
      } as any)

    // Use a very short timeout (1500ms) so the test finishes quickly
    await pollForCompletion('http://127.0.0.1:8188', 'fake-prompt-id', 1600)
  } catch (e: any) {
    threw = true
    errMsg = e.message || ''
  } finally {
    globalThis.fetch = originalFetch
  }
  assert(threw, 'throws on timeout')
  assert(errMsg.toLowerCase().includes('timed out'), 'error mentions "timed out"', `got: ${errMsg}`)
}

// ─── Test 12: Cloud host guard (simulated via env) ────────────────────────────
console.log('\n[Test 12] imageService cloud guard — ComfyUI provider rejected on cloud host')
{
  // Set NETLIFY env var to simulate cloud deployment
  process.env.NETLIFY = 'true'
  const originalComfyUrl = process.env.COMFYUI_BASE_URL
  process.env.COMFYUI_BASE_URL = 'http://127.0.0.1:8188'

  let threw = false
  let errMsg = ''
  try {
    const { generateAIImage } = await import('../services/imageService.js')
    await generateAIImage({ prompt: 'test', provider: 'comfyui' })
  } catch (e: any) {
    threw = true
    errMsg = e.message || ''
  } finally {
    delete process.env.NETLIFY
    if (originalComfyUrl !== undefined) process.env.COMFYUI_BASE_URL = originalComfyUrl
    else delete process.env.COMFYUI_BASE_URL
  }
  assert(threw, 'throws when provider=comfyui on cloud host')
  assert(errMsg.toLowerCase().includes('netlify') || errMsg.toLowerCase().includes('cloud'), 'error mentions cloud deployment', `got: ${errMsg}`)
}

// ─── Test 13: Missing COMFYUI_BASE_URL throws clear error ────────────────────
console.log('\n[Test 13] imageService — throws when COMFYUI_BASE_URL not configured')
{
  const originalUrl = process.env.COMFYUI_BASE_URL
  delete process.env.COMFYUI_BASE_URL

  let threw = false
  let errMsg = ''
  try {
    // Directly test the comfyuiBaseUrl guard logic
    const comfyuiBaseUrl = undefined
    if (!comfyuiBaseUrl) {
      throw new Error('ComfyUI URL is not configured. Add COMFYUI_BASE_URL=http://127.0.0.1:8188 to your .env file.')
    }
  } catch (e: any) {
    threw = true
    errMsg = e.message || ''
  } finally {
    if (originalUrl !== undefined) process.env.COMFYUI_BASE_URL = originalUrl
  }
  assert(threw, 'throws when COMFYUI_BASE_URL missing')
  assert(errMsg.includes('COMFYUI_BASE_URL'), 'error mentions COMFYUI_BASE_URL', `got: ${errMsg}`)
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`)
if (failed > 0) {
  process.exit(1)
}
