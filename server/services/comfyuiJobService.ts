import path from 'path'
import { randomUUID } from 'crypto'
import { configService } from './configService.js'
import { imageHistoryService, SavedImageMetadata } from './imageHistoryService.js'
import {
  checkComfyUIStatus,
  downloadOutputImage,
  getWorkflowCapabilities,
  listAvailableCheckpointModels,
  loadOrBuildWorkflow,
  normalizeComfyUIBaseUrl,
  pollForCompletion,
  resolveWorkflowPath,
  submitWorkflow,
} from './comfyuiService.js'

export type ComfyUIJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ComfyUIJobRequest {
  ownerId: string
  prompt: string
  negativePrompt?: string
  workflowId: string
  width: number
  height: number
  count: number
  steps: number
  cfgScale: number
  seed?: number
  checkpointModel?: string
}

export interface ComfyUIJobSnapshot {
  id: string
  status: ComfyUIJobStatus
  progress: number
  currentImage: number
  totalImages: number
  images: SavedImageMetadata[]
  error?: string
}

interface ComfyUIJob extends ComfyUIJobSnapshot {
  ownerId: string
  request: ComfyUIJobRequest
  abortController: AbortController
  promptId?: string
}

const MAX_IMAGE_PIXELS = 786_432
const JOB_TIMEOUT_MS = 10 * 60 * 1000

function resolveDataDir(): string {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR)
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) return path.resolve('/tmp')
  return path.resolve(process.cwd(), 'server', 'data')
}

function snapshot(job: ComfyUIJob): ComfyUIJobSnapshot {
  const { ownerId: _ownerId, request: _request, abortController: _abortController, promptId: _promptId, ...publicJob } = job
  return publicJob
}

function validateRequest(request: ComfyUIJobRequest): void {
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 2000) {
    throw new Error('Prompt must contain between 1 and 2,000 characters.')
  }
  if ((request.negativePrompt || '').length > 1000) throw new Error('Negative prompt must be 1,000 characters or fewer.')
  for (const [label, dimension] of [['Width', request.width], ['Height', request.height]] as const) {
    if (!Number.isInteger(dimension) || dimension < 256 || dimension > 1024 || dimension % 8 !== 0) {
      throw new Error(`${label} must be a multiple of 8 between 256 and 1,024 pixels.`)
    }
  }
  if (request.width * request.height > MAX_IMAGE_PIXELS) {
    throw new Error('Image dimensions exceed the local GPU safety limit. Reduce width or height for 8 GB VRAM.')
  }
  if (!Number.isInteger(request.count) || request.count < 1 || request.count > 4) {
    throw new Error('Choose between 1 and 4 images per request.')
  }
  if (!Number.isInteger(request.steps) || request.steps < 1 || request.steps > 50) {
    throw new Error('Steps must be between 1 and 50.')
  }
  if (!Number.isFinite(request.cfgScale) || request.cfgScale < 0 || request.cfgScale > 20) {
    throw new Error('CFG scale must be between 0 and 20.')
  }
  if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff)) {
    throw new Error('Seed must be an integer between 0 and 4,294,967,295.')
  }
}

function getWorkflowDirectory(): string {
  return path.join(resolveDataDir(), 'comfyui-workflows')
}

class ComfyUIJobService {
  private readonly jobs = new Map<string, ComfyUIJob>()
  private runQueue: Promise<void> = Promise.resolve()

  public start(request: ComfyUIJobRequest): ComfyUIJobSnapshot {
    validateRequest(request)
    const config = configService.getConfig()
    if (!config.comfyuiEnabled) throw new Error('Local ComfyUI image generation is disabled in Settings.')
    const baseUrl = normalizeComfyUIBaseUrl(config.comfyuiBaseUrl || 'http://127.0.0.1:8188')
    const workflowPath = resolveWorkflowPath(
      request.workflowId,
      getWorkflowDirectory(),
      config.comfyuiWorkflowPath
    )
    const id = randomUUID()
    const job: ComfyUIJob = {
      id,
      ownerId: request.ownerId,
      request: { ...request, prompt: request.prompt.trim() },
      status: 'queued',
      progress: 0,
      currentImage: 0,
      totalImages: request.count,
      images: [],
      abortController: new AbortController(),
    }
    this.jobs.set(id, job)
    this.runQueue = this.runQueue.then(
      () => this.run(job, baseUrl, workflowPath),
      () => this.run(job, baseUrl, workflowPath)
    )
    return snapshot(job)
  }

  public get(id: string, ownerId: string): ComfyUIJobSnapshot | null {
    const job = this.jobs.get(id)
    return job && job.ownerId === ownerId ? snapshot(job) : null
  }

  public async cancel(id: string, ownerId: string): Promise<ComfyUIJobSnapshot | null> {
    const job = this.jobs.get(id)
    if (!job || job.ownerId !== ownerId) return null
    if (job.status === 'queued' || job.status === 'running') {
      job.abortController.abort()
      if (job.promptId) await this.cancelPrompt(job.promptId)
      job.status = 'cancelled'
    }
    return snapshot(job)
  }

  private async cancelPrompt(promptId: string): Promise<void> {
    const config = configService.getConfig()
    const baseUrl = normalizeComfyUIBaseUrl(config.comfyuiBaseUrl || 'http://127.0.0.1:8188')
    try {
      const queueResponse = await fetch(`${baseUrl}/queue`, { signal: AbortSignal.timeout(3000) })
      const queue = queueResponse.ok ? await queueResponse.json() as any : null
      const running = (queue?.queue_running || []).some((entry: any) => entry?.[1] === promptId || entry?.prompt_id === promptId)
      await fetch(`${baseUrl}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
        signal: AbortSignal.timeout(3000),
      })
      if (running) {
        await fetch(`${baseUrl}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(3000) })
      }
    } catch (error) {
      console.warn('[ComfyUI] Could not stop cancelled prompt:', error)
    }
  }

  private async run(job: ComfyUIJob, baseUrl: string, workflowPath: string): Promise<void> {
    if (job.abortController.signal.aborted) {
      job.status = 'cancelled'
      return
    }
    job.status = 'running'

    try {
      const connection = await checkComfyUIStatus(baseUrl)
      if (!connection.connected) {
        throw new Error(connection.error || `ComfyUI is not responding at ${baseUrl}. Start it on 127.0.0.1:8188.`)
      }

      const config = configService.getConfig()
      const availableModels = await listAvailableCheckpointModels(baseUrl)
      const chosenModel = job.request.checkpointModel || config.comfyuiModel || undefined
      if (chosenModel && !availableModels.includes(chosenModel)) {
        throw new Error(`ComfyUI checkpoint "${chosenModel}" is not installed. Choose an available model in Image settings.`)
      }
      const settings = {
        prompt: job.request.prompt,
        workflowPath,
      }
      const template = loadOrBuildWorkflow(settings)
      const capabilities = getWorkflowCapabilities(template)
      if (!capabilities.prompt) throw new Error('Selected workflow has no supported positive prompt input.')
      if (job.request.negativePrompt && !capabilities.negativePrompt) {
        throw new Error('Selected workflow does not support a negative prompt.')
      }
      if (chosenModel && !capabilities.checkpointModel) {
        throw new Error('Selected workflow does not support checkpoint selection; clear the model choice or use a compatible workflow.')
      }

      for (let index = 0; index < job.request.count; index++) {
        if (job.abortController.signal.aborted) throw new Error('Image generation cancelled.')
        job.currentImage = index + 1
        job.progress = Math.round((index / job.request.count) * 100)
        const seed = job.request.seed === undefined ? undefined : (job.request.seed + index) >>> 0
        const workflow = loadOrBuildWorkflow({
          prompt: job.request.prompt,
          negativePrompt: job.request.negativePrompt || undefined,
          width: capabilities.width ? job.request.width : undefined,
          height: capabilities.height ? job.request.height : undefined,
          steps: capabilities.steps ? job.request.steps : undefined,
          cfgScale: capabilities.cfgScale ? job.request.cfgScale : undefined,
          seed: capabilities.seed ? seed : undefined,
          checkpointModel: capabilities.checkpointModel ? chosenModel : undefined,
          workflowPath,
        })
        const clientId = `mana-ai-${randomUUID()}`
        job.promptId = await submitWorkflow(baseUrl, workflow, clientId, job.abortController.signal)
        const outputs = await pollForCompletion(
          baseUrl,
          job.promptId,
          JOB_TIMEOUT_MS,
          (progress) => {
            job.progress = Math.min(99, Math.round(((index + progress / 100) / job.request.count) * 100))
          },
          job.abortController.signal,
          clientId
        )
        if (!outputs.length) throw new Error('ComfyUI completed but returned no output image.')

        for (const output of outputs) {
          const buffer = await downloadOutputImage(baseUrl, output.filename, output.subfolder, output.type)
          const extension = path.extname(output.filename).slice(1).toLowerCase()
          const safeExtension = extension === 'jpg' || extension === 'webp' ? extension : 'png'
          const image = imageHistoryService.save({
            ownerId: job.ownerId,
            outputFolder: config.comfyuiOutputFolder || 'generated-images',
            extension: safeExtension,
            buffer,
            prompt: job.request.prompt,
            negativePrompt: job.request.negativePrompt,
            aspectRatio: getAspectRatio(job.request.width, job.request.height),
            quality: 'standard',
            provider: 'Local ComfyUI',
            width: job.request.width,
            height: job.request.height,
            seed: seed,
            createdAt: new Date().toISOString(),
            workflowId: job.request.workflowId,
            model: chosenModel,
            steps: capabilities.steps ? job.request.steps : undefined,
            cfgScale: capabilities.cfgScale ? job.request.cfgScale : undefined,
          })
          job.images.push(image)
        }
        job.promptId = undefined
        job.progress = Math.round(((index + 1) / job.request.count) * 100)
      }
      job.status = 'completed'
      job.progress = 100
    } catch (error: any) {
      if (job.abortController.signal.aborted || /cancelled/i.test(error?.message || '')) {
        job.status = 'cancelled'
        job.error = 'Generation cancelled.'
      } else {
        job.status = 'failed'
        job.error = error?.message || 'ComfyUI image generation failed.'
      }
    }
  }
}

function getAspectRatio(width: number, height: number): '1:1' | '16:9' | '9:16' {
  const ratio = width / height
  if (ratio > 1.25) return '16:9'
  if (ratio < 0.8) return '9:16'
  return '1:1'
}

export const comfyuiJobService = new ComfyUIJobService()