import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { GeneratedImageMetadata } from '../types.js'

export interface SavedImageMetadata extends GeneratedImageMetadata {
  id: string
  ownerId: string
  workflowId: string
  model?: string
  steps?: number
  cfgScale?: number
}

interface StoredImage extends SavedImageMetadata {
  outputFolder: string
  filename: string
}

export interface SaveImageInput extends Omit<GeneratedImageMetadata, 'id' | 'url' | 'base64Data'> {
  ownerId: string
  outputFolder: string
  extension: 'png' | 'jpg' | 'webp'
  buffer: Buffer
  workflowId: string
}

function resolveDataDir(): string {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR)
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) return path.resolve('/tmp')
  try {
    if (typeof __dirname !== 'undefined') return path.resolve(__dirname, '../data')
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data')
    }
  } catch {}
  return path.resolve(process.cwd(), 'server', 'data')
}

const DATA_DIR = resolveDataDir()
const HISTORY_PATH = path.join(DATA_DIR, 'generated-image-history.json')

function isSafeFolderName(folder: string): boolean {
  return /^[a-zA-Z0-9_-]{1,48}$/.test(folder)
}

function readHistory(): StoredImage[] {
  if (!fs.existsSync(HISTORY_PATH)) return []
  const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'))
  if (!Array.isArray(parsed)) throw new Error('Generated image history file is invalid.')
  return parsed
}

function toPublicImage({ outputFolder: _outputFolder, filename: _filename, ...image }: StoredImage): SavedImageMetadata {
  return image
}

class ImageHistoryService {
  public save(input: SaveImageInput): SavedImageMetadata {
    if (!isSafeFolderName(input.outputFolder)) {
      throw new Error('Output folder must be a simple folder name.')
    }

    const id = randomUUID()
    const filename = `${id}.${input.extension}`
    const outputDirectory = path.resolve(DATA_DIR, input.outputFolder)
    if (!outputDirectory.startsWith(`${DATA_DIR}${path.sep}`)) {
      throw new Error('Image output directory is outside the local data folder.')
    }
    fs.mkdirSync(outputDirectory, { recursive: true })
    fs.writeFileSync(path.join(outputDirectory, filename), input.buffer, { flag: 'wx' })

    const { ownerId, outputFolder, extension: _extension, buffer: _buffer, ...metadata } = input
    const stored: StoredImage = {
      ...metadata,
      id,
      ownerId,
      outputFolder,
      filename,
      url: `/api/generated-images/${id}`,
      provider: 'Local ComfyUI',
      createdAt: metadata.createdAt || new Date().toISOString(),
      workflowId: input.workflowId,
    }

    try {
      const history = readHistory()
      history.unshift(stored)
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const temporaryPath = `${HISTORY_PATH}.${process.pid}.tmp`
      fs.writeFileSync(temporaryPath, JSON.stringify(history, null, 2), 'utf-8')
      fs.renameSync(temporaryPath, HISTORY_PATH)
    } catch (error) {
      try { fs.unlinkSync(path.join(outputDirectory, filename)) } catch {}
      throw error
    }

    return toPublicImage(stored)
  }

  public list(ownerId: string): SavedImageMetadata[] {
    return readHistory()
      .filter((image) => image.ownerId === ownerId)
      .map(toPublicImage)
  }

  public getFilePath(id: string): { filePath: string; extension: string } | null {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const image = readHistory().find((item) => item.id === id)
    if (!image || !isSafeFolderName(image.outputFolder)) return null

    const outputDirectory = path.resolve(DATA_DIR, image.outputFolder)
    const filePath = path.resolve(outputDirectory, image.filename)
    if (
      !outputDirectory.startsWith(`${DATA_DIR}${path.sep}`) ||
      path.dirname(filePath) !== outputDirectory ||
      !fs.existsSync(filePath)
    ) return null

    return { filePath, extension: path.extname(image.filename).slice(1) }
  }
}

export const imageHistoryService = new ImageHistoryService()