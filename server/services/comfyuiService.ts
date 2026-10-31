/**
 * ComfyUI Local Image Generation Service
 *
 * Connects to a locally running ComfyUI instance via its HTTP API.
 * Full async flow: status check → submit workflow → poll history → download output.
 *
 * ComfyUI must be running on the user's PC (default: http://127.0.0.1:8188).
 * This service CANNOT be used from a Netlify/cloud deployment — caller must check first.
 */

import fs from 'fs'
import path from 'path'

export interface ComfyUIStatus {
  connected: boolean
  baseUrl: string
  queueSize?: number
  error?: string
}

export interface ComfyUIOutputImage {
  filename: string
  subfolder: string
  type: string
}

export interface ComfyUIGenerateOptions {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  seed?: number
  checkpointModel?: string
  workflowPath?: string
  count?: number
  signal?: AbortSignal
  onProgress?: (progress?: number, node?: string, stage?: string) => void
}

export interface ComfyUIWorkflowCapabilities {
  prompt: boolean
  negativePrompt: boolean
  width: boolean
  height: boolean
  steps: boolean
  cfgScale: boolean
  seed: boolean
  checkpointModel: boolean
}

export interface ComfyUIWorkflowTemplate {
  id: string
  name: string
  valid: boolean
  error?: string
  capabilities?: ComfyUIWorkflowCapabilities
}

export function normalizeComfyUIBaseUrl(baseUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('ComfyUI URL must be a valid localhost URL.')
  }

  const hostname = parsed.hostname.toLowerCase()
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('ComfyUI must use a localhost URL without credentials or a path.')
  }

  return parsed.origin.replace(/\/$/, '')
}

/**
 * Check whether ComfyUI is reachable and return queue size.
 */
export async function checkComfyUIStatus(baseUrl: string): Promise<ComfyUIStatus> {
  const cleanUrl = normalizeComfyUIBaseUrl(baseUrl)

  try {
    const res = await fetch(`${cleanUrl}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    })

    if (!res.ok) {
      return {
        connected: false,
        baseUrl,
        error: `ComfyUI responded with HTTP ${res.status}`,
      }
    }

    // Also try to get queue info
    let queueSize = 0
    try {
      const queueRes = await fetch(`${cleanUrl}/queue`, {
        signal: AbortSignal.timeout(2000),
      })
      if (queueRes.ok) {
        const queueData: any = await queueRes.json()
        queueSize =
          (queueData?.queue_running?.length || 0) +
          (queueData?.queue_pending?.length || 0)
      }
    } catch {
      // queue info is optional
    }

    return { connected: true, baseUrl, queueSize }
  } catch (err: any) {
    const msg = (err?.message || '').toLowerCase()
    if (
      msg.includes('fetch failed') ||
      msg.includes('econnrefused') ||
      msg.includes('connection refused') ||
      msg.includes('enotfound') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('aborted')
    ) {
      return {
        connected: false,
        baseUrl,
        error:
          'ComfyUI is not running. Start it with: python main.py --listen 127.0.0.1 --port 8188',
      }
    }
    return { connected: false, baseUrl, error: err.message || 'Unknown error' }
  }
}

/**
 * Build the default ComfyUI API-format workflow (nodes 1-7).
 * Works with any standard SD 1.5 or SDXL checkpoint.
 *
 * Node layout:
 *   1: CheckpointLoaderSimple
 *   2: CLIPTextEncode (positive)
 *   3: CLIPTextEncode (negative)
 *   4: EmptyLatentImage
 *   5: KSampler
 *   6: VAEDecode
 *   7: SaveImage
 */
/**
 * Load a workflow from a JSON file and inject generation parameters into
 * the appropriate ComfyUI node types.
 */
function loadAndInjectWorkflow(
  workflowPath: string,
  options: ComfyUIGenerateOptions
): Record<string, any> {
  const raw = fs.readFileSync(workflowPath, 'utf-8')
  const workflow: Record<string, any> = JSON.parse(raw)
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || !Object.keys(workflow).length) {
    throw new Error('Workflow must be a non-empty ComfyUI API-format node graph.')
  }

  const effectiveSeed = options.seed ?? Math.floor(Math.random() * 2 ** 32)

  for (const [, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object') {
      throw new Error('Workflow contains a node without a valid class_type and inputs object.')
    }
    const ct: string = node.class_type

    if (ct === 'CheckpointLoaderSimple' && options.checkpointModel) {
      node.inputs.ckpt_name = options.checkpointModel
    }

    if (ct === 'KSampler') {
      if (options.steps !== undefined) node.inputs.steps = options.steps
      if (options.cfgScale !== undefined) node.inputs.cfg = options.cfgScale
      node.inputs.seed = effectiveSeed
    }

    if (ct === 'EmptyLatentImage') {
      if (options.width !== undefined) node.inputs.width = options.width
      if (options.height !== undefined) node.inputs.height = options.height
      if (node.inputs.batch_size !== undefined) node.inputs.batch_size = 1
    }

    if (ct === 'SaveImage') {
      node.inputs.filename_prefix = 'ManaAI'
    }

    // Positive prompt: first CLIPTextEncode in the file
    if (ct === 'CLIPTextEncode') {
      // Heuristic: if this node is connected to the KSampler "positive" input,
      // it's the positive prompt node. We do a simple first-match injection.
      // To distinguish positive vs negative, check if any KSampler references
      // this node id as "positive".
      const thisId = Object.entries(workflow).find(([, n]) => n === node)?.[0]
      const isPositive = Object.values(workflow).some(
        (n: any) =>
          n?.class_type === 'KSampler' &&
          Array.isArray(n?.inputs?.positive) &&
          String(n.inputs.positive[0]) === String(thisId)
      )
      const isNegative = Object.values(workflow).some(
        (n: any) =>
          n?.class_type === 'KSampler' &&
          Array.isArray(n?.inputs?.negative) &&
          String(n.inputs.negative[0]) === String(thisId)
      )
      if (isPositive) node.inputs.text = options.prompt
      if (isNegative && options.negativePrompt) node.inputs.text = options.negativePrompt
    }
  }

  const capabilities = getWorkflowCapabilities(workflow)
  if (!capabilities.prompt) throw new Error('Selected workflow has no supported positive prompt input.')
  if (options.negativePrompt !== undefined && !capabilities.negativePrompt) {
    throw new Error('Selected workflow does not support a negative prompt.')
  }
  if (options.width !== undefined && !capabilities.width) {
    throw new Error('Selected workflow does not support width settings.')
  }
  if (options.height !== undefined && !capabilities.height) {
    throw new Error('Selected workflow does not support height settings.')
  }
  if (options.steps !== undefined && !capabilities.steps) {
    throw new Error('Selected workflow does not support step settings.')
  }
  if (options.cfgScale !== undefined && !capabilities.cfgScale) {
    throw new Error('Selected workflow does not support CFG settings.')
  }
  if (options.seed !== undefined && !capabilities.seed) {
    throw new Error('Selected workflow does not support seed settings.')
  }
  if (options.checkpointModel && !capabilities.checkpointModel) {
    throw new Error('Selected workflow does not support checkpoint selection.')
  }

  return workflow
}

/**
 * Build (or load and inject) a ComfyUI API workflow from the given options.
 */
export function loadOrBuildWorkflow(options: ComfyUIGenerateOptions): Record<string, any> {
  if (!options.workflowPath) {
    throw new Error('Select or configure a ComfyUI API-format workflow before generating an image.')
  }
  if (!fs.existsSync(options.workflowPath)) {
    throw new Error('The selected ComfyUI workflow file could not be found.')
  }
  try {
    return loadAndInjectWorkflow(options.workflowPath, options)
  } catch (err: any) {
    throw new Error(`Invalid ComfyUI workflow JSON: ${err.message}`)
  }
}

export function getWorkflowCapabilities(
  workflow: Record<string, any>
): ComfyUIWorkflowCapabilities {
  const samplerNodes = Object.values(workflow).filter(
    (node: any) => node?.class_type === 'KSampler' && node.inputs
  ) as any[]
  const clipNodeIds = new Set(
    Object.entries(workflow)
      .filter(([, node]: [string, any]) => node?.class_type === 'CLIPTextEncode')
      .map(([id]) => id)
  )
  const hasSamplerReference = (field: 'positive' | 'negative') =>
    samplerNodes.some((node) => {
      const reference = node.inputs[field]
      return Array.isArray(reference) && clipNodeIds.has(String(reference[0]))
    })
  const latentNodes = Object.values(workflow).filter(
    (node: any) => node?.class_type === 'EmptyLatentImage' && node.inputs
  ) as any[]
  const checkpointNodes = Object.values(workflow).filter(
    (node: any) => node?.class_type === 'CheckpointLoaderSimple' && node.inputs
  ) as any[]

  return {
    prompt: hasSamplerReference('positive'),
    negativePrompt: hasSamplerReference('negative'),
    width: latentNodes.some((node) => 'width' in node.inputs),
    height: latentNodes.some((node) => 'height' in node.inputs),
    steps: samplerNodes.some((node) => 'steps' in node.inputs),
    cfgScale: samplerNodes.some((node) => 'cfg' in node.inputs),
    seed: samplerNodes.some((node) => 'seed' in node.inputs),
    checkpointModel: checkpointNodes.some((node) => 'ckpt_name' in node.inputs),
  }
}

export function resolveWorkflowPath(
  workflowId: string,
  workflowDirectory: string,
  configuredWorkflowPath?: string
): string {
  if (workflowId === 'configured') {
    if (configuredWorkflowPath && fs.existsSync(configuredWorkflowPath)) return configuredWorkflowPath
    throw new Error('The configured ComfyUI workflow file could not be found.')
  }

  const filename = path.basename(workflowId)
  if (filename !== workflowId || !filename.toLowerCase().endsWith('.json')) {
    throw new Error('Invalid ComfyUI workflow selection.')
  }

  const directory = path.resolve(workflowDirectory)
  const candidate = path.resolve(directory, filename)
  if (path.dirname(candidate).toLowerCase() !== directory.toLowerCase()) {
    throw new Error('Invalid ComfyUI workflow selection.')
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error('The selected ComfyUI workflow file could not be found.')
  }
  return candidate
}

export function listWorkflowTemplates(
  workflowDirectory: string,
  configuredWorkflowPath?: string
): ComfyUIWorkflowTemplate[] {
  const templates: ComfyUIWorkflowTemplate[] = []
  if (configuredWorkflowPath && fs.existsSync(configuredWorkflowPath)) {
    try {
      const workflow = JSON.parse(fs.readFileSync(configuredWorkflowPath, 'utf-8'))
      validateWorkflowGraph(workflow)
      templates.push({
        id: 'configured',
        name: 'Configured workflow',
        valid: true,
        capabilities: getWorkflowCapabilities(workflow),
      })
    } catch (error: any) {
      templates.push({
        id: 'configured',
        name: 'Configured workflow',
        valid: false,
        error: error.message || 'Invalid workflow JSON',
      })
    }
  }

  if (!fs.existsSync(workflowDirectory)) return templates
  for (const filename of fs.readdirSync(workflowDirectory)) {
    if (!filename.toLowerCase().endsWith('.json')) continue
    try {
      const workflowPath = resolveWorkflowPath(filename, workflowDirectory)
      const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'))
      validateWorkflowGraph(workflow)
      templates.push({
        id: filename,
        name: path.basename(filename, path.extname(filename)),
        valid: true,
        capabilities: getWorkflowCapabilities(workflow),
      })
    } catch (error: any) {
      templates.push({
        id: filename,
        name: path.basename(filename, path.extname(filename)),
        valid: false,
        error: error.message || 'Invalid workflow JSON',
      })
    }
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

function validateWorkflowGraph(workflow: unknown): asserts workflow is Record<string, any> {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || !Object.keys(workflow).length) {
    throw new Error('Workflow must be a non-empty ComfyUI API-format node graph.')
  }
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object' || typeof (node as any).class_type !== 'string' || !(node as any).inputs || typeof (node as any).inputs !== 'object') {
      throw new Error('Workflow contains a node without a valid class_type and inputs object.')
    }
  }
}

export async function listAvailableCheckpointModels(baseUrl: string): Promise<string[]> {
  const cleanUrl = normalizeComfyUIBaseUrl(baseUrl)
  const response = await fetch(`${cleanUrl}/object_info/CheckpointLoaderSimple`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) {
    throw new Error(`Could not read ComfyUI checkpoint models (HTTP ${response.status}).`)
  }
  const info: any = await response.json()
  const choices = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
  return Array.isArray(choices) ? choices.filter((name: unknown): name is string => typeof name === 'string') : []
}

/**
 * Submit a workflow to ComfyUI and return the prompt_id.
 */
export async function submitWorkflow(
  baseUrl: string,
  workflow: Record<string, any>,
  clientId = 'mana-ai',
  signal?: AbortSignal
): Promise<string> {
  const cleanUrl = normalizeComfyUIBaseUrl(baseUrl)

  const res = await fetch(`${cleanUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: signal || AbortSignal.timeout(15000),
  })

  let body: any = {}
  try {
    body = await res.json()
  } catch {}

  if (!res.ok || body.error) {
    const errMsg = body?.error?.message || body?.error || `HTTP ${res.status}`
    // Common ComfyUI error: model/checkpoint not found
    if (
      typeof errMsg === 'string' &&
      (errMsg.toLowerCase().includes('not found') ||
        errMsg.toLowerCase().includes('invalid') ||
        errMsg.toLowerCase().includes('checkpoint'))
    ) {
      throw new Error(
        `ComfyUI rejected the workflow: ${errMsg}\n` +
          'Make sure the checkpoint model is installed in ComfyUI/models/checkpoints/ and matches COMFYUI_MODEL in your .env.'
      )
    }
    throw new Error(`ComfyUI workflow submission failed: ${errMsg}`)
  }

  if (!body.prompt_id) {
    throw new Error('ComfyUI did not return a prompt_id. Check that ComfyUI is running and accepting requests.')
  }

  return body.prompt_id as string
}

/**
 * Poll GET /history/{promptId} until the job completes or times out.
 * Returns the list of output images from the completed job.
 */
export async function pollForCompletion(
  baseUrl: string,
  promptId: string,
  timeoutMs = 120_000,
  onProgress?: (progress: number, node?: string) => void,
  signal?: AbortSignal,
  clientId = 'mana-ai'
): Promise<ComfyUIOutputImage[]> {
  const cleanUrl = normalizeComfyUIBaseUrl(baseUrl)
  const deadline = Date.now() + timeoutMs
  const pollIntervalMs = 1500
  const socketUrl = new URL('/ws', cleanUrl)
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  socketUrl.searchParams.set('clientId', clientId)
  let socket: WebSocket | undefined
  try {
    if (typeof WebSocket !== 'undefined') {
      socket = new WebSocket(socketUrl)
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data))
          if (message.type === 'progress') {
            const value = Number(message.data?.value)
            const max = Number(message.data?.max)
            if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
              onProgress?.(Math.round((value / max) * 100), undefined, 'Generating image')
            }
          } else if (message.type === 'executing') {
            onProgress?.(
              undefined,
              message.data?.node || undefined,
              message.data?.node ? 'Running workflow nodes' : 'Finalizing image'
            )
          }
        } catch {}
      })
    }
  } catch {
    socket = undefined
  }

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Image generation cancelled.')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, pollIntervalMs)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('Image generation cancelled.'))
        }, { once: true })
      })
      if (signal?.aborted) throw new Error('Image generation cancelled.')

      let data: any = null
      try {
        const res = await fetch(`${cleanUrl}/history/${encodeURIComponent(promptId)}`, {
          signal: signal || AbortSignal.timeout(8000),
        })
        if (res.ok) data = await res.json()
      } catch (error: any) {
        if (signal?.aborted) throw new Error('Image generation cancelled.')
        if (error?.name !== 'TimeoutError' && error?.name !== 'AbortError') throw error
        continue
      }

      const entry = data?.[promptId]
      if (!entry) continue

      const statusStr = entry?.status?.status_str
      const messages: any[] = entry?.status?.messages || []
      const hasError = messages.some(
        (message: any) => Array.isArray(message) && typeof message[0] === 'string' && message[0].toLowerCase().includes('error')
      )

      if (statusStr === 'error' || hasError) {
        const detail = messages
          .filter((message: any) => Array.isArray(message) && message[0]?.toLowerCase?.().includes('error'))
          .map((message: any) => (Array.isArray(message[1]) ? JSON.stringify(message[1]) : String(message[1])))
          .join('; ')
        const errorMessage = detail || 'Unknown error in job execution.'
        if (/out of memory|cuda.*alloc|cudnn_status_alloc_failed/i.test(errorMessage)) {
          throw new Error('ComfyUI ran out of GPU memory. Try a smaller image, fewer steps, or close other GPU-heavy applications.')
        }
        throw new Error(`ComfyUI generation error: ${errorMessage}`)
      }

      const outputs: Record<string, any> = entry?.outputs || {}
      const images: ComfyUIOutputImage[] = []

      for (const nodeOutput of Object.values(outputs)) {
        if (nodeOutput?.images && Array.isArray(nodeOutput.images)) {
          for (const image of nodeOutput.images) {
            if (image?.filename) {
              images.push({
                filename: image.filename,
                subfolder: image.subfolder || '',
                type: image.type || 'output',
              })
            }
          }
        }
      }

      if (images.length > 0) return images
      if (entry?.status?.completed === true) {
        throw new Error('ComfyUI finished the workflow but produced no output image.')
      }
    }
  } finally {
    socket?.close()
  }

  throw new Error(
    `ComfyUI generation timed out after ${timeoutMs / 1000} seconds. ` +
      'The model may be loading for the first time, or your GPU is under heavy load. ' +
      'Try again — subsequent generations are faster once the model is cached.'
  )
}

/**
 * Download a generated image from ComfyUI's /view endpoint.
 */
export async function downloadOutputImage(
  baseUrl: string,
  filename: string,
  subfolder: string,
  type = 'output'
): Promise<Buffer> {
  const cleanUrl = normalizeComfyUIBaseUrl(baseUrl)
  const params = new URLSearchParams({ filename, subfolder, type })
  const url = `${cleanUrl}/view?${params.toString()}`

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })

  if (!res.ok) {
    throw new Error(
      `Failed to download ComfyUI output image "${filename}": HTTP ${res.status}`
    )
  }

  return Buffer.from(await res.arrayBuffer())
}

/**
 * Full end-to-end generation: build workflow → submit → poll → download first image.
 */
export async function generateWithComfyUI(
  options: ComfyUIGenerateOptions,
  baseUrl: string
): Promise<{ buffer: Buffer; filename: string; width: number; height: number; seed: number }> {
  const workflow = loadOrBuildWorkflow(options)

  options.onProgress?.(undefined, undefined, 'Submitting workflow')
  const promptId = await submitWorkflow(baseUrl, workflow, 'mana-ai', options.signal)
  console.log(`[ComfyUI] Job submitted, promptId=${promptId}`)

  options.onProgress?.(undefined, undefined, 'Loading model')
  const outputImages = await pollForCompletion(
    baseUrl,
    promptId,
    120_000,
    (progress, node, stage) => options.onProgress?.(progress, node, stage),
    options.signal
  )
  if (outputImages.length === 0) {
    throw new Error('ComfyUI completed but returned no output images.')
  }

  options.onProgress?.(undefined, undefined, 'Processing result')
  const first = outputImages[0]
  const buffer = await downloadOutputImage(baseUrl, first.filename, first.subfolder, first.type)

  // Extract seed from the workflow for metadata
  let usedSeed = options.seed ?? 0
  for (const node of Object.values(workflow)) {
    if (node?.class_type === 'KSampler' && node?.inputs?.seed !== undefined) {
      usedSeed = node.inputs.seed
      break
    }
  }

  return {
    buffer,
    filename: first.filename,
    width: options.width ?? 512,
    height: options.height ?? 512,
    seed: usedSeed,
  }
}
