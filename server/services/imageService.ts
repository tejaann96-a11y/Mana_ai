import OpenAI from 'openai'
import { configService } from './configService.js'
import { GeneratedImageMetadata } from '../types.js'
import { generateWithComfyUI, checkComfyUIStatus } from './comfyuiService.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export interface ImageGenerationOptions {
  prompt: string
  negativePrompt?: string
  aspectRatio?: '1:1' | '16:9' | '9:16'
  quality?: 'standard' | 'hd'
  provider?: 'openai' | 'pollinations' | 'huggingface' | 'selfhosted' | 'comfyui'
  seed?: number
  steps?: number
  cfgScale?: number
  checkpointModel?: string
  workflowPath?: string
  signal?: AbortSignal
  onProgress?: (progress?: number, node?: string, stage?: string) => void
}

function resolveMediaDir(): string {
  if (process.env.MEDIA_DIR) return process.env.MEDIA_DIR
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) return path.join('/tmp', 'media')
  try {
    if (typeof __dirname !== 'undefined') return path.resolve(__dirname, '../data/media')
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/media')
    }
  } catch {}
  return path.resolve(process.cwd(), 'server', 'data', 'media')
}

const MEDIA_DIR = resolveMediaDir()

function ensureMediaDir(): string {
  if (!fs.existsSync(MEDIA_DIR)) {
    try {
      fs.mkdirSync(MEDIA_DIR, { recursive: true })
    } catch (e) {
      console.warn('[ImageService] Failed to create MEDIA_DIR:', e)
    }
  }
  return MEDIA_DIR
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Service for image generation through the explicitly selected provider, without silent failover.
 * Guarantee: Zero visible logos, overlays, or application watermarks added to generated output.
 */
export async function generateAIImage(options: ImageGenerationOptions): Promise<GeneratedImageMetadata> {
  const { prompt, negativePrompt, aspectRatio = '1:1', quality = 'standard', provider, seed } = options

  const cleanPrompt = prompt.trim()
  if (!cleanPrompt) {
    throw new Error('Please enter a description for the image you want to generate.')
  }

  const config = configService.getConfig()
  const activeOpenAIKey = config.openaiApiKey || process.env.OPENAI_API_KEY
  const activeHFKey = config.huggingfaceApiKey || process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY
  const selfHostedUrl = config.selfHostedImageUrl || process.env.SELF_HOSTED_IMAGE_URL
  const comfyuiBaseUrl = config.comfyuiBaseUrl || process.env.COMFYUI_BASE_URL
  const isCloudHost = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME)

  ensureMediaDir()

  const preferredProvider = provider || config.imageProvider || 'comfyui'

  // 0. LOCAL COMFYUI
  if (preferredProvider === 'comfyui') {
    if (isCloudHost) {
      throw new Error(
        'Local ComfyUI is available only when Mana AI is running on this PC. Start Mana AI locally; no remote ComfyUI tunnel is used.'
      )
    }
    if (!comfyuiBaseUrl) {
      throw new Error(
        'ComfyUI URL is not configured.\n' +
        'Add COMFYUI_BASE_URL=http://127.0.0.1:8188 to your .env file and restart the server.'
      )
    }

    // Pre-flight connection check with a clear error if ComfyUI is down
    const status = await checkComfyUIStatus(comfyuiBaseUrl)
    if (!status.connected) {
      throw new Error(
        `Cannot reach ComfyUI at ${comfyuiBaseUrl}.\n` +
        (status.error || 'Make sure ComfyUI is running: python main.py --listen 127.0.0.1 --port 8188')
      )
    }

    // Resolve dimensions from aspect ratio
    let width = 512
    let height = 512
    if (aspectRatio === '16:9') { width = 768; height = 432 }
    else if (aspectRatio === '9:16') { width = 432; height = 768 }

    console.log(`[ImageService] Generating with local ComfyUI at ${comfyuiBaseUrl}: "${cleanPrompt.slice(0, 60)}..."`)

    const result = await generateWithComfyUI(
      {
        prompt: cleanPrompt,
        negativePrompt: negativePrompt || 'blurry, distorted, low quality, artifacts, watermark, text',
        width,
        height,
        steps: options.steps ?? config.comfyuiSteps ?? 20,
        cfgScale: options.cfgScale ?? config.comfyuiCfgScale ?? 7,
        seed,
        checkpointModel: options.checkpointModel || config.comfyuiModel || undefined,
        workflowPath: options.workflowPath || config.comfyuiWorkflowPath || undefined,
        signal: options.signal,
        onProgress: options.onProgress,
      },
      comfyuiBaseUrl
    )

    const filename = `img-comfy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`
    const filePath = path.join(MEDIA_DIR, filename)
    try {
      fs.writeFileSync(filePath, result.buffer)
    } catch (error) {
      throw new Error(`ComfyUI generated the image, but saving it locally failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    const base64Data = `data:image/png;base64,${result.buffer.toString('base64')}`
    return {
      url: `/api/media/${filename}`,
      base64Data,
      prompt: cleanPrompt,
      negativePrompt,
      aspectRatio,
      quality: quality || 'standard',
      provider: 'Local ComfyUI',
      width: result.width,
      height: result.height,
      seed: result.seed,
      createdAt: new Date().toISOString(),
    }
  }

  // 1. SELF-HOSTED GPU / COMFYUI / DIFFUSERS INFERENCE
  if (preferredProvider === 'selfhosted' && selfHostedUrl) {
    try {
      console.log(`[ImageService] Submitting to self-hosted GPU endpoint: ${selfHostedUrl}`)
      let width = 1024
      let height = 1024
      if (aspectRatio === '16:9') {
        width = 1280
        height = 720
      } else if (aspectRatio === '9:16') {
        width = 720
        height = 1280
      }

      const res = await fetch(selfHostedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: cleanPrompt,
          negative_prompt: negativePrompt || 'blurry, distorted, low quality, artifacts, watermark',
          width,
          height,
          seed: seed || Math.floor(Math.random() * 1000000),
          quality,
        }),
      })

      if (!res.ok) {
        throw new Error(`Self-hosted image endpoint returned HTTP ${res.status}`)
      }

      if (res.ok) {
        const contentType = res.headers.get('content-type') || ''
        let buffer: Buffer

        if (contentType.includes('application/json')) {
          const json = await res.json()
          if (json.image_base64 || json.output_base64) {
            buffer = Buffer.from(json.image_base64 || json.output_base64, 'base64')
          } else if (json.image_url) {
            const imgRes = await fetch(json.image_url)
            buffer = Buffer.from(await imgRes.arrayBuffer())
          } else {
            throw new Error('Self-hosted response missing image_base64 or image_url')
          }
        } else {
          buffer = Buffer.from(await res.arrayBuffer())
        }

        const filename = `img-sh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer)

        const base64Data = buffer.toString('base64')
        return {
          url: `/api/media/${filename}`,
          base64Data: `data:image/png;base64,${base64Data}`,
          prompt: cleanPrompt,
          negativePrompt,
          aspectRatio,
          quality,
          provider: 'Self-Hosted GPU (FLUX / SDXL)',
          width,
          height,
          createdAt: new Date().toISOString(),
        }
      }
    } catch (err: any) {
      throw new Error(`Self-hosted image generation failed: ${err.message}`)
    }
  }

  // 2. OPENAI DALL-E 3 API (100% Watermark-Free Photorealistic)
  if (preferredProvider === 'openai') {
    if (!activeOpenAIKey) throw new Error('OpenAI is selected but no API key is configured.')
    try {
      const openai = new OpenAI({ apiKey: activeOpenAIKey })

      let size: '1024x1024' | '1792x1024' | '1024x1792' = '1024x1024'
      let width = 1024
      let height = 1024

      if (aspectRatio === '16:9') {
        size = '1792x1024'
        width = 1792
        height = 1024
      } else if (aspectRatio === '9:16') {
        size = '1024x1792'
        width = 1024
        height = 1792
      }

      console.log(`[ImageService] Generating with OpenAI DALL-E 3: "${cleanPrompt.slice(0, 50)}..."`)

      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: cleanPrompt,
        size,
        quality: quality === 'hd' ? 'hd' : 'standard',
        n: 1,
      })

      const imageItem = response.data?.[0]
      if (imageItem?.url) {
        const localFilename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`
        const localFilePath = path.join(MEDIA_DIR, localFilename)
        let base64Data: string | undefined

        try {
          const imgRes = await fetch(imageItem.url)
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer())
            fs.writeFileSync(localFilePath, buf)
            base64Data = `data:image/png;base64,${buf.toString('base64')}`
          }
        } catch {}

        return {
          url: base64Data ? `/api/media/${localFilename}` : imageItem.url,
          base64Data,
          prompt: cleanPrompt,
          revisedPrompt: imageItem.revised_prompt || undefined,
          aspectRatio,
          quality,
          provider: 'OpenAI DALL-E 3 (Watermark-Free)',
          width,
          height,
          createdAt: new Date().toISOString(),
        }
      }
      throw new Error('OpenAI returned no image URL.')
    } catch (err: any) {
      if (err.status === 401) {
        throw new Error('Invalid OpenAI API Key. Please verify your API key in Settings.')
      }
      throw new Error(`OpenAI image generation failed: ${err.message}`)
    }
  }

  // 3. HUGGING FACE INFERENCE (FLUX.1 [schnell] Open-Weights)
  if (preferredProvider === 'huggingface') {
    if (!activeHFKey) throw new Error('Hugging Face is selected but no API token is configured.')
    try {
      console.log(`[ImageService] Submitting to Hugging Face FLUX.1 [schnell]...`)
      const hfRes = await fetch('https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeHFKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: cleanPrompt,
          parameters: {
            negative_prompt: negativePrompt || undefined,
            seed: seed || Math.floor(Math.random() * 1000000),
          },
        }),
      })

      if (hfRes.ok) {
        const buf = Buffer.from(await hfRes.arrayBuffer())
        const filename = `img-hf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpeg`
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buf)

        const base64Data = `data:image/jpeg;base64,${buf.toString('base64')}`
        return {
          url: `/api/media/${filename}`,
          base64Data,
          prompt: cleanPrompt,
          negativePrompt,
          aspectRatio,
          quality,
          provider: 'Hugging Face (FLUX.1 [schnell])',
          width: 1024,
          height: 1024,
          createdAt: new Date().toISOString(),
        }
      }
      throw new Error(`Hugging Face returned HTTP ${hfRes.status}.`)
    } catch (hfErr: any) {
      throw new Error(`Hugging Face image generation failed: ${hfErr.message}`)
    }
  }

  if (preferredProvider !== 'pollinations') {
    throw new Error(`Image provider "${preferredProvider}" is not configured. Choose a provider in Settings.`)
  }

  // 4. POLLINATIONS AI FLUX WITH WATERMARK SUPPRESSION (&nologo=true) & EXPONENTIAL BACKOFF
  let width = 1024
  let height = 1024

  if (aspectRatio === '16:9') {
    width = 1280
    height = 720
  } else if (aspectRatio === '9:16') {
    width = 720
    height = 1280
  }

  let enhancedPrompt = cleanPrompt
  if (!/(realistic|photorealistic|detailed|cinematic|portrait|quality|rendering)/i.test(cleanPrompt)) {
    enhancedPrompt = `${cleanPrompt}, highly detailed, cinematic lighting, 8k resolution, photorealistic`
  }

  const candidateModels = ['flux', 'turbo']
  let lastErrorMsg = ''

  for (const model of candidateModels) {
    const currentSeed = seed || Math.floor(Math.random() * 1000000)
    const encodedPrompt = encodeURIComponent(enhancedPrompt)
    // nologo=true explicitly suppresses any visible provider logo/watermark overlay
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&seed=${currentSeed}&nologo=true&model=${model}`

    // Retry with exponential backoff and jitter
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        const jitter = Math.floor(Math.random() * 400)
        await sleep(1000 + jitter)
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 22000)

      try {
        const res = await fetch(imageUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'ManaAI/1.0',
            'Accept': 'image/jpeg,image/png,image/*,*/*',
          },
        })
        clearTimeout(timeout)

        if (res.status === 402 || res.status === 429) {
          lastErrorMsg =
            'Public image diffusion cluster is temporarily rate-limited. Please retry in a few moments, or configure an OpenAI API Key in Settings.'
          continue
        }

        if (!res.ok) {
          lastErrorMsg = `Diffusion cluster returned HTTP ${res.status}`
          continue
        }

        const buf = Buffer.from(await res.arrayBuffer())

        if (buf.length < 5000) {
          const textPreview = buf.toString('utf-8').slice(0, 200)
          if (textPreview.includes('limit') || textPreview.startsWith('{')) {
            lastErrorMsg = 'Diffusion cluster limit reached. Please retry in 30 seconds.'
            continue
          }
        }

        const localFilename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`
        fs.writeFileSync(path.join(MEDIA_DIR, localFilename), buf)

        const base64Data = `data:image/jpeg;base64,${buf.toString('base64')}`
        return {
          url: `/api/media/${localFilename}`,
          base64Data,
          prompt: cleanPrompt,
          aspectRatio,
          quality: quality || 'standard',
          provider: `FLUX.1 Diffusion (${model.toUpperCase()}, Watermark-Free)`,
          width,
          height,
          createdAt: new Date().toISOString(),
        }
      } catch (fetchErr: any) {
        clearTimeout(timeout)
        if (fetchErr.name === 'AbortError') {
          lastErrorMsg = 'Image generation timed out after 22 seconds due to high cluster load. Please retry.'
        } else {
          lastErrorMsg = fetchErr.message || 'Network error reaching image generation cluster.'
        }
      }
    }
  }

  throw new Error(
    lastErrorMsg ||
      'AI Image generation is temporarily busy or rate-limited. Please retry in 30 seconds, or provide an OpenAI API key in Settings.'
  )
}
