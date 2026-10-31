import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { loadImage } from '@napi-rs/canvas'
import { imageSize } from 'image-size'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import * as XLSX from '@e965/xlsx'
import Tesseract from 'tesseract.js'

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? path.join('/tmp', 'mana-data')
    : path.resolve(process.cwd(), 'server', 'data')
const FILES_DIR = path.join(DATA_DIR, 'conversation-files')
const BLOBS_DIR = path.join(FILES_DIR, 'blobs')
const INDEX_PATH = path.join(FILES_DIR, 'index.json')
export const MAX_CONVERSATION_FILE_BYTES = 15 * 1024 * 1024
const MAX_FILES_PER_SESSION = 50
const MAX_SESSION_FILE_BYTES = 100 * 1024 * 1024
const MAX_FILE_TEXT_CHARS = 2_000_000
const MAX_PDF_PAGES = 500
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_CHUNKS_PER_FILE = 3_000
const CHUNK_SIZE = 900
const CHUNK_OVERLAP = 120
const SUPPORTED_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
}

export interface ConversationFile {
  id: string
  sessionId: string
  userId: string
  name: string
  mimeType: string
  sizeBytes: number
  uploadedAt: string
  extractionStatus: 'complete' | 'partial' | 'image'
  extractionNote?: string
  pageCount?: number
  worksheets?: Array<{ name: string; hidden: boolean }>
  chunkCount: number
}

interface FileChunk {
  id: string
  docId: string
  docTitle: string
  chunkIndex: number
  text: string
  tokensApprox: number
  sourceLocation?: string
}

interface StoredConversationFile extends ConversationFile {
  chunks: FileChunk[]
}

interface UploadedFileInput {
  userId: string
  sessionId: string
  originalName: string
  mimeType: string
  buffer: Buffer
}

export interface ConversationFileMatch {
  chunk: FileChunk
  score: number
  docTitle: string
}

// Functions are bundled to CommonJS on Netlify, where import.meta.url is empty.
const require = createRequire(
  typeof __filename !== 'undefined' ? __filename : import.meta.url,
)
const englishOcrData = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean }

const wordExtractorModule = require('word-extractor') as new () => {
  extract(buffer: Buffer): Promise<{ getBody(): string }>
}

export class ConversationFileService {
  private files: StoredConversationFile[] = []

  constructor() {
    this.ensureDirectories()
    this.loadIndex()
  }

  private ensureDirectories() {
    fs.mkdirSync(BLOBS_DIR, { recursive: true })
  }

  private loadIndex() {
    if (!fs.existsSync(INDEX_PATH)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) as StoredConversationFile[]
      this.files = Array.isArray(parsed) ? parsed.filter((file) => file && file.chunks) : []
    } catch (error) {
      console.error('[ConversationFileService] Could not load the file index:', error)
      throw new Error('Uploaded-file storage is unavailable because its index is corrupted.')
    }
  }

  private saveIndex() {
    this.ensureDirectories()
    const temporaryPath = `${INDEX_PATH}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(this.files), 'utf8')
    fs.renameSync(temporaryPath, INDEX_PATH)
  }

  private safeName(input: string): string {
    const basename = path.basename(input.replace(/\\/g, '/'))
    const sanitized = basename.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180)
    if (!sanitized || sanitized === '.' || sanitized === '..') {
      throw new Error('A valid filename is required.')
    }
    return sanitized
  }

  private validateZip(buffer: Buffer) {
    const searchStart = Math.max(0, buffer.length - 65_557)
    let eocd = -1
    for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
      if (buffer.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset
        break
      }
    }
    if (eocd < 0) throw new Error('The document is not a valid Office ZIP container.')

    const entryCount = buffer.readUInt16LE(eocd + 10)
    if (entryCount > 10_000) throw new Error('The Office document contains too many internal entries to process safely.')
    let cursor = buffer.readUInt32LE(eocd + 16)
    let uncompressedBytes = 0
    for (let entry = 0; entry < entryCount; entry++) {
      if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('The Office document has a malformed ZIP directory.')
      }
      const compressed = buffer.readUInt32LE(cursor + 20)
      const uncompressed = buffer.readUInt32LE(cursor + 24)
      const nameLength = buffer.readUInt16LE(cursor + 28)
      const extraLength = buffer.readUInt16LE(cursor + 30)
      const commentLength = buffer.readUInt16LE(cursor + 32)
      uncompressedBytes += uncompressed
      if (uncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES ||
          (uncompressed > 1024 * 1024 && uncompressed / Math.max(compressed, 1) > 100)) {
        throw new Error('The Office document expands beyond the safe processing limit.')
      }
      cursor += 46 + nameLength + extraLength + commentLength
    }
  }

  private validateSignature(extension: string, buffer: Buffer) {
    const valid =
      extension === '.png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
      extension === '.jpg' || extension === '.jpeg' ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff :
      extension === '.webp' ? buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' :
      extension === '.pdf' ? buffer.subarray(0, 5).toString('ascii') === '%PDF-' :
      extension === '.doc' || extension === '.xls' ? buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) :
      extension === '.docx' || extension === '.xlsx' ? buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) :
      !buffer.includes(0)
    if (!valid) throw new Error(`The file contents do not match the .${extension.slice(1)} extension.`)
    if (extension === '.docx' || extension === '.xlsx') this.validateZip(buffer)
  }

  private ocrWorker: Promise<Tesseract.Worker> | null = null

  private async getOcrWorker() {
    if (!this.ocrWorker) {
      this.ocrWorker = Tesseract.createWorker('eng', 1, {
        langPath: englishOcrData.langPath,
        gzip: englishOcrData.gzip,
        cachePath: path.join(FILES_DIR, 'ocr-cache'),
        workerBlobURL: false,
        errorHandler: (error) => console.error('[ConversationFileService] OCR worker error:', error),
      })
    }
    return this.ocrWorker
  }

  private async recognizeImage(buffer: Buffer): Promise<string> {
    const worker = await this.getOcrWorker()
    const result = await worker.recognize(buffer)
    return result.data.text.trim()
  }

  private chunksFor(id: string, name: string, sections: Array<{ location: string; text: string }>): FileChunk[] {
    const chunks: FileChunk[] = []
    for (const section of sections) {
      const text = section.text.replace(/\r\n/g, '\n').trim()
      if (!text) continue
      let start = 0
      while (start < text.length && chunks.length < MAX_CHUNKS_PER_FILE) {
        let end = Math.min(start + CHUNK_SIZE, text.length)
        if (end < text.length) {
          const newline = text.lastIndexOf('\n', end)
          if (newline > start + CHUNK_SIZE / 2) end = newline
        }
        const excerpt = text.slice(start, end).trim()
        if (excerpt) {
          const chunkIndex = chunks.length + 1
          chunks.push({
            id: `${id}-chunk-${chunkIndex}`,
            docId: id,
            docTitle: name,
            chunkIndex,
            text: excerpt,
            tokensApprox: Math.ceil(excerpt.length / 4),
            sourceLocation: section.location,
          })
        }
        if (end >= text.length) break
        start = Math.max(start + 1, end - CHUNK_OVERLAP)
      }
      if (chunks.length >= MAX_CHUNKS_PER_FILE) break
    }
    const totalChunks = chunks.length
    for (const chunk of chunks) {
      chunk.sourceLocation = `${chunk.sourceLocation || 'Document'} · chunk ${chunk.chunkIndex} of ${totalChunks}`
    }
    return chunks
  }

  private async extract(
    extension: string,
    buffer: Buffer
  ): Promise<{
    sections: Array<{ location: string; text: string }>
    status: ConversationFile['extractionStatus']
    note?: string
    pageCount?: number
    worksheets?: ConversationFile['worksheets']
  }> {
    if (extension.startsWith('.png') || extension === '.jpg' || extension === '.jpeg' || extension === '.webp') {
      let dimensions: ReturnType<typeof imageSize>
      try {
        dimensions = imageSize(buffer)
      } catch {
        throw new Error('The image file is corrupted or could not be decoded.')
      }
      if (dimensions.width * dimensions.height > 20_000_000) {
        throw new Error('Images must contain no more than 20 megapixels for safe local processing.')
      }
      let decodedImage
      try {
        decodedImage = await loadImage(buffer)
      } catch {
        throw new Error('The image file is corrupted or could not be decoded.')
      }
      if (decodedImage.width * decodedImage.height > 20_000_000) {
        throw new Error('Images must contain no more than 20 megapixels for safe local processing.')
      }
      let text = ''
      let note = 'No readable English text was detected. Image understanding requires a local vision-capable Ollama model.'
      try {
        text = await this.recognizeImage(buffer)
        if (text) note = 'English OCR extracted visible text. Image questions require a local vision-capable Ollama model.'
      } catch (error) {
        note = `Local OCR was unavailable: ${error instanceof Error ? error.message : 'OCR error'}. Image understanding requires a local vision-capable Ollama model.`
        console.warn('[ConversationFileService] Could not OCR uploaded image:', error)
      }
      return {
        sections: text ? [{ location: 'OCR', text }] : [],
        status: 'image',
        note,
      }
    }

    if (extension === '.pdf') {
      const parser = new PDFParse({ data: buffer })
      try {
        const info = await parser.getInfo()
        const pageCount = info.total
        const result = await parser.getText({ first: Math.min(Math.max(pageCount, 1), MAX_PDF_PAGES) })
        const sections = result.pages.map((page) => ({
          location: `Page ${page.num}`,
          text: page.text,
        }))
        let note = pageCount > MAX_PDF_PAGES
          ? `Only the first ${MAX_PDF_PAGES} of ${pageCount} PDF pages were processed.`
          : undefined
        let status: ConversationFile['extractionStatus'] = pageCount > MAX_PDF_PAGES ? 'partial' : 'complete'
        if (sections.some((page) => page.text.trim().length < 20)) {
          try {
            const worker = await this.getOcrWorker()
            for (const page of sections.filter((item) => item.text.trim().length < 20)) {
              const pageNumber = Number(page.location.replace('Page ', ''))
              const screenshot = await parser.getScreenshot({
                partial: [pageNumber],
                imageBuffer: true,
                scale: 1.25,
              })
              const image = screenshot.pages[0]?.data
              if (image) {
                const text = (await worker.recognize(Buffer.from(image))).data.text.trim()
                if (text) page.text = text
              }
            }
          } catch (error) {
            status = 'partial'
            note = [
              note,
              `Scanned-page OCR could not run: ${error instanceof Error ? error.message : 'OCR error'}.`,
            ].filter(Boolean).join(' ')
          }
        }
        const totalChars = sections.reduce((total, page) => total + page.text.length, 0)
        if (totalChars > MAX_FILE_TEXT_CHARS) {
          let remaining = MAX_FILE_TEXT_CHARS
          for (const page of sections) {
            page.text = page.text.slice(0, remaining)
            remaining -= page.text.length
          }
          status = 'partial'
          note = [note, 'Text extraction was truncated after reaching the safe processing limit.'].filter(Boolean).join(' ')
        }
        return { sections, status, note, pageCount }
      } finally {
        await parser.destroy()
      }
    }

    if (extension === '.docx') {
      const result = await mammoth.extractRawText({ buffer })
      const text = result.value.slice(0, MAX_FILE_TEXT_CHARS)
      return {
        sections: [{ location: 'Document', text }],
        status: result.value.length > MAX_FILE_TEXT_CHARS ? 'partial' : 'complete',
        note: result.value.length > MAX_FILE_TEXT_CHARS ? 'Text extraction was truncated after reaching the safe processing limit.' : undefined,
      }
    }

    if (extension === '.doc') {
      const extractor = new wordExtractorModule()
      const document = await extractor.extract(buffer)
      const text = document.getBody()
      return {
        sections: [{ location: 'Document', text: text.slice(0, MAX_FILE_TEXT_CHARS) }],
        status: text.length > MAX_FILE_TEXT_CHARS ? 'partial' : 'complete',
        note: text.length > MAX_FILE_TEXT_CHARS ? 'Text extraction was truncated after reaching the safe processing limit.' : undefined,
      }
    }

    if (extension === '.xlsx' || extension === '.xls' || extension === '.csv') {
      const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellText: true })
      const worksheets: NonNullable<ConversationFile['worksheets']> = workbook.SheetNames.map((name) => ({
        name,
        hidden: Boolean(workbook.Workbook?.Sheets?.find((sheet) => sheet.name === name)?.Hidden),
      }))
      const sections: Array<{ location: string; text: string }> = []
      let processedCells = 0
      let note: string | undefined
      for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName]
        const hidden = worksheets.find((sheet) => sheet.name === sheetName)?.hidden || false
        const range = worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']) : null
        if (!range) continue
        const headerCells = new Map<number, string>()
        for (let col = range.s.c; col <= range.e.c; col++) {
          const headerCell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })]
          const header = headerCell?.w ?? (headerCell?.v === undefined ? '' : String(headerCell.v))
          if (header) headerCells.set(col, header)
        }
        const lines: string[] = []
        let linesLength = 0
        for (let row = range.s.r; row <= range.e.r; row++) {
          const values: string[] = []
          for (let col = range.s.c; col <= range.e.c; col++) {
            processedCells += 1
            if (processedCells > 500_000) {
              sections.push({
                location: `Worksheet "${sheetName}"${hidden ? ' (hidden)' : ''}`,
                text: lines.join('\n'),
              })
              return {
                sections,
                worksheets,
                status: 'partial',
                note: `Spreadsheet extraction stopped at 500,000 cells. Remaining cells and worksheets were not processed.${hidden ? ' Hidden worksheets are included in the extracted worksheet list.' : ''}`,
              }
            }
            const address = XLSX.utils.encode_cell({ r: row, c: col })
            const cell = worksheet[address]
            if (!cell) continue
            const displayed = cell.w ?? (cell.v === undefined ? '' : String(cell.v))
            const formula = cell.f ? ` (formula: ${cell.f}${cell.v !== undefined ? `; value: ${String(cell.v)}` : ''})` : ''
            const columnHeader = row === range.s.r ? '' : headerCells.get(col)
            if (displayed || formula) {
              values.push(`${address}=${columnHeader ? `${columnHeader}: ` : ''}${displayed}${formula}`)
            }
          }
          if (values.length) {
            const line = values.join(' | ')
            lines.push(line)
            linesLength += line.length + 1
          }
          if (sections.reduce((length, section) => length + section.text.length, 0) + linesLength >= MAX_FILE_TEXT_CHARS) break
        }
        const alreadyExtracted = sections.reduce((length, section) => length + section.text.length, 0)
        const sheetText = lines.join('\n')
        const remainingChars = Math.max(0, MAX_FILE_TEXT_CHARS - alreadyExtracted)
        sections.push({
          location: `Worksheet "${sheetName}"${hidden ? ' (hidden)' : ''}`,
          text: sheetText.slice(0, remainingChars),
        })
        if (sheetText.length > remainingChars || alreadyExtracted + sheetText.length >= MAX_FILE_TEXT_CHARS) {
          return {
            sections,
            worksheets,
            status: 'partial',
            note: 'Spreadsheet text was truncated after reaching the safe processing limit. Later worksheets were not processed.',
          }
        }
      }
      const hiddenNames = worksheets.filter((sheet) => sheet.hidden).map((sheet) => sheet.name)
      if (hiddenNames.length) note = `Hidden worksheets were included: ${hiddenNames.join(', ')}.`
      return { sections, worksheets, status: 'complete', note }
    }

    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (text.length > MAX_FILE_TEXT_CHARS) {
      return {
        sections: [{ location: 'Text', text: text.slice(0, MAX_FILE_TEXT_CHARS) }],
        status: 'partial',
        note: 'Text extraction was truncated after reaching the safe processing limit.',
      }
    }
    return { sections: [{ location: 'Text', text }], status: 'complete' }
  }

  public async upload(input: UploadedFileInput): Promise<ConversationFile> {
    if (!input.buffer.length) throw new Error('The uploaded file is empty.')
    if (input.buffer.length > MAX_CONVERSATION_FILE_BYTES) throw new Error('Each uploaded file must be 15 MB or smaller.')
    const name = this.safeName(input.originalName)
    const extension = path.extname(name).toLowerCase()
    const expectedMime = SUPPORTED_TYPES[extension]
    if (!expectedMime) throw new Error('This file format is not supported.')
    this.validateSignature(extension, input.buffer)
    const sessionFiles = this.files.filter((file) => file.userId === input.userId && file.sessionId === input.sessionId)
    if (sessionFiles.length >= MAX_FILES_PER_SESSION) {
      throw new Error(`This conversation can contain up to ${MAX_FILES_PER_SESSION} uploaded files.`)
    }
    if (sessionFiles.reduce((total, file) => total + file.sizeBytes, 0) + input.buffer.length > MAX_SESSION_FILE_BYTES) {
      throw new Error('This conversation has reached its 100 MB total upload limit.')
    }
    const extracted = await this.extract(extension, input.buffer)
    const id = randomUUID()
    const chunks = this.chunksFor(id, name, extracted.sections)
    const file: StoredConversationFile = {
      id,
      sessionId: input.sessionId,
      userId: input.userId,
      name,
      mimeType: expectedMime,
      sizeBytes: input.buffer.length,
      uploadedAt: new Date().toISOString(),
      extractionStatus: extracted.status,
      extractionNote: extracted.note,
      pageCount: extracted.pageCount,
      worksheets: extracted.worksheets,
      chunkCount: chunks.length,
      chunks,
    }
    const storagePath = path.join(BLOBS_DIR, id)
    fs.writeFileSync(storagePath, input.buffer, { flag: 'wx' })
    this.files.unshift(file)
    try {
      this.saveIndex()
    } catch (error) {
      this.files = this.files.filter((entry) => entry.id !== id)
      fs.unlinkSync(storagePath)
      throw error
    }
    return this.publicMetadata(file)
  }

  private publicMetadata(file: StoredConversationFile): ConversationFile {
    const { chunks: _chunks, ...metadata } = file
    return metadata
  }

  public listForSession(userId: string, sessionId: string): ConversationFile[] {
    return this.files
      .filter((file) => file.userId === userId && file.sessionId === sessionId)
      .map((file) => this.publicMetadata(file))
  }

  public search(userId: string, sessionId: string, query: string, limit = 5): ConversationFileMatch[] {
    const terms = query.toLowerCase().split(/[^a-z0-9_-]+/).filter((term) => term.length >= 2)
    const ordinalPages: Record<string, number> = {
      first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
      sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    }
    const numericPage = query.match(/\b(?:page|pg\.?)\s*(\d+)\b/i)
    const ordinalPage = query.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+page\b/i)
    const pageNumber = numericPage
      ? Number(numericPage[1])
      : ordinalPage
        ? ordinalPages[ordinalPage[1].toLowerCase()]
        : undefined
    const sessionFiles = this.files.filter((file) => file.userId === userId && file.sessionId === sessionId)
    if (/\b(summar(?:y|ize|ise)|overview|key points|highlights|whole|entire)\b/i.test(query)) {
      const selected: ConversationFileMatch[] = []
      const filesByTitle = sessionFiles
        .filter((file) => file.chunks.length > 0)
        .sort((left, right) => {
          const titleScore = (file: StoredConversationFile) =>
            terms.reduce((score, term) => score + (file.name.toLowerCase().includes(term) ? 1 : 0), 0)
          return titleScore(right) - titleScore(left)
        })
      const titleMatches = filesByTitle.filter((file) =>
        terms.some((term) => file.name.toLowerCase().includes(term))
      )
      const filesWithContent = titleMatches.length ? titleMatches : filesByTitle
      let remaining = limit
      for (const [fileIndex, file] of filesWithContent.entries()) {
        const filesLeft = filesWithContent.length - fileIndex
        const sampleCount = Math.min(file.chunks.length, Math.max(1, Math.floor(remaining / filesLeft)))
        const indexes = Array.from({ length: sampleCount }, (_, index) =>
          sampleCount === 1 ? 0 : Math.round((index * (file.chunks.length - 1)) / (sampleCount - 1))
        )
        for (const index of new Set(indexes)) {
          const chunk = file.chunks[index]
          if (chunk) selected.push({ chunk, score: 0, docTitle: file.name })
          if (selected.length >= limit) break
        }
        remaining = limit - selected.length
        if (remaining <= 0) break
      }
      return selected
    }
    const scored: ConversationFileMatch[] = []
    for (const file of sessionFiles) {
      for (const chunk of file.chunks) {
        const text = chunk.text.toLowerCase()
        const title = file.name.toLowerCase()
        const location = chunk.sourceLocation?.toLowerCase() || ''
        const score = terms.reduce(
          (total, term) => total + (text.includes(term) ? 2 : 0) + (title.includes(term) ? 1 : 0) + (location.includes(term) ? 2 : 0),
          0
        ) + (pageNumber && location.includes(`page ${pageNumber}`) ? 20 : 0)
        if (score > 0) scored.push({ chunk, score, docTitle: file.name })
      }
    }
    scored.sort((left, right) => right.score - left.score)
    if (scored.length) return scored.slice(0, limit)
    return sessionFiles.flatMap((file) => file.chunks.slice(0, 1).map((chunk) => ({
      chunk,
      score: 0,
      docTitle: file.name,
    }))).slice(0, Math.min(limit, sessionFiles.length))
  }

  public getVisionImages(userId: string, sessionId: string): Array<{ name: string; mimeType: string; data: string }> {
    const images = this.files
      .filter((file) => file.userId === userId && file.sessionId === sessionId && file.mimeType.startsWith('image/'))
    if (images.length > 5) {
      throw new Error('Local vision supports up to five images per conversation. Remove extra images before asking about them.')
    }
    const selected: Array<{ name: string; mimeType: string; data: string }> = []
    let totalBytes = 0
    for (const image of images) {
      if (totalBytes + image.sizeBytes > 12 * 1024 * 1024) {
        throw new Error('The images in this conversation exceed the 12 MB local vision request limit. Remove an image or use smaller images.')
      }
      const filePath = path.join(BLOBS_DIR, image.id)
      if (!fs.existsSync(filePath)) throw new Error(`The stored image "${image.name}" is missing.`)
      totalBytes += image.sizeBytes
      selected.push({
        name: image.name,
        mimeType: image.mimeType,
        data: fs.readFileSync(filePath).toString('base64'),
      })
    }
    return selected
  }

  public remove(userId: string, sessionId: string, id: string): boolean {
    const file = this.files.find((entry) => entry.id === id && entry.userId === userId && entry.sessionId === sessionId)
    if (!file) return false
    this.files = this.files.filter((entry) => entry.id !== id)
    this.saveIndex()
    const filePath = path.join(BLOBS_DIR, id)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return true
  }

  public removeSession(userId: string, sessionId: string) {
    const files = this.files.filter((entry) => entry.userId === userId && entry.sessionId === sessionId)
    if (!files.length) return
    this.files = this.files.filter((entry) => entry.userId !== userId || entry.sessionId !== sessionId)
    this.saveIndex()
    for (const file of files) {
      const filePath = path.join(BLOBS_DIR, file.id)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    }
  }

  public async shutdownOcrWorker() {
    if (!this.ocrWorker) return
    const worker = await this.ocrWorker
    this.ocrWorker = null
    await worker.terminate()
  }
}

export const conversationFileService = new ConversationFileService()
