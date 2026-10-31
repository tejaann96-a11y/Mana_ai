import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import * as XLSX from '@e965/xlsx'
import { createCanvas } from '@napi-rs/canvas'

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name)
    const raw = Buffer.from(content)
    const compressed = deflateRawSync(raw)
    const checksum = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const entryCount = Object.keys(files).length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entryCount, 8)
  end.writeUInt16LE(entryCount, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function createPdf(pageTexts: string[]): Buffer {
  const objects = new Map<number, string>()
  const fontId = 3 + pageTexts.length * 2
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  objects.set(2, `<< /Type /Pages /Kids [${pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`)
  pageTexts.forEach((text, index) => {
    const pageId = 3 + index * 2
    const contentId = pageId + 1
    const stream = `BT /F1 14 Tf 50 750 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`)
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  })
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const maxObject = fontId
  const pieces = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  let position = pieces[0].length
  for (let id = 1; id <= maxObject; id++) {
    const object = Buffer.from(`${id} 0 obj\n${objects.get(id)}\nendobj\n`)
    offsets[id] = position
    pieces.push(object)
    position += object.length
  }
  const xrefOffset = position
  const xref = [
    `xref\n0 ${maxObject + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
  ].join('')
  pieces.push(Buffer.from(`${xref}trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`))
  return Buffer.concat(pieces)
}

function createScannedPdf(image: Buffer): Buffer {
  const content = Buffer.from('q\n500 0 0 62 56 700 cm\n/Im1 Do\nQ\n')
  const objects = new Map<number, Buffer>([
    [1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')],
    [2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [3, Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>')],
    [4, Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 800 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`),
      image,
      Buffer.from('\nendstream'),
    ])],
    [5, Buffer.from(`<< /Length ${content.length} >>\nstream\n${content.toString('ascii')}endstream`)],
  ])
  const pieces = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  let position = pieces[0].length
  for (let id = 1; id <= 5; id++) {
    const object = Buffer.concat([Buffer.from(`${id} 0 obj\n`), objects.get(id)!, Buffer.from('\nendobj\n')])
    offsets[id] = position
    pieces.push(object)
    position += object.length
  }
  const xrefOffset = position
  const xref = [
    'xref\n0 6\n',
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
  ].join('')
  pieces.push(Buffer.from(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`))
  return Buffer.concat(pieces)
}

async function main() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-conversation-files-'))
  const previousDataDir = process.env.DATA_DIR
  let stopOcrWorker: (() => Promise<void>) | undefined
  let apiServer: ChildProcess | undefined
  let mockModelServer: Server | undefined
  let visionPayload: { messages?: Array<{ role: string; images?: string[] }> } | undefined
  process.env.DATA_DIR = temporaryDirectory
  try {
    const { conversationFileService, ConversationFileService } = await import('../server/services/conversationFileService.js')
    stopOcrWorker = () => conversationFileService.shutdownOcrWorker()
    const owner = 'test-owner'
    const session = 'test-session'
    const upload = (name: string, buffer: Buffer, mimeType = 'application/octet-stream') =>
      conversationFileService.upload({ userId: owner, sessionId: session, originalName: name, mimeType, buffer })

    const text = await upload('notes.txt', Buffer.from('The documented target amount is 125 dollars.', 'utf8'), 'text/plain')
    assert.equal(text.extractionStatus, 'complete')
    assert.match(conversationFileService.search(owner, session, 'target amount')[0]?.chunk.text || '', /125 dollars/)
    assert.equal(conversationFileService.search('another-owner', session, 'target amount').length, 0)
    assert.equal(conversationFileService.search(owner, 'another-session', 'target amount').length, 0)

    const csv = await upload('sales.csv', Buffer.from('Month,Revenue\nJanuary,125\nFebruary,200\n', 'utf8'), 'text/csv')
    assert.equal(csv.extractionStatus, 'complete')
    assert.match(conversationFileService.search(owner, session, 'February revenue')[0]?.chunk.text || '', /200/)

    const workbook = XLSX.utils.book_new()
    const visibleSheet = XLSX.utils.aoa_to_sheet([['Item', 'Amount'], ['Coffee', 125]])
    visibleSheet.B2 = { t: 'n', v: 125, w: '125.00', f: 'SUM(100,25)' }
    const hiddenSheet = XLSX.utils.aoa_to_sheet([['Secret total'], [450]])
    XLSX.utils.book_append_sheet(workbook, visibleSheet, 'Summary')
    XLSX.utils.book_append_sheet(workbook, hiddenSheet, 'Hidden detail')
    XLSX.utils.book_set_sheet_visibility(workbook, 'Hidden detail', 1)
    const xlsx = await upload(
      'report.xlsx',
      Buffer.from(XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' })),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    assert.deepEqual(xlsx.worksheets?.map((sheet) => [sheet.name, sheet.hidden]), [['Summary', false], ['Hidden detail', true]])
    const formulas = conversationFileService.search(owner, session, 'SUM formula')
    assert.match(formulas.map((match) => match.chunk.text).join('\n'), /formula: SUM\(100,25\)/)
    assert.match(conversationFileService.search(owner, session, 'Hidden detail 450')[0]?.chunk.text || '', /450/)

    const legacyWorkbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(legacyWorkbook, XLSX.utils.aoa_to_sheet([['Legacy value'], [775]]), 'Legacy')
    const xls = await upload(
      'legacy.xls',
      Buffer.from(XLSX.write(legacyWorkbook, { bookType: 'xls', type: 'buffer' })),
      'application/vnd.ms-excel'
    )
    assert.equal(xls.worksheets?.[0]?.name, 'Legacy')
    assert.match(conversationFileService.search(owner, session, 'Legacy 775')[0]?.chunk.text || '', /775/)

    const docx = createZip({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Invoice total is 325 dollars.</w:t></w:r></w:p></w:body></w:document>',
    })
    const word = await upload('invoice.docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert.equal(word.extractionStatus, 'complete')
    assert.match(conversationFileService.search(owner, session, 'invoice total')[0]?.chunk.text || '', /325 dollars/)

    const pdf = await upload('pages.pdf', createPdf(['First page details', 'Second page details', 'Third page detail is 999']), 'application/pdf')
    assert.equal(pdf.pageCount, 3)
    assert.match(conversationFileService.search(owner, session, 'third page')[0]?.chunk.sourceLocation || '', /^Page 3/)
    assert.match(conversationFileService.search(owner, session, '999')[0]?.chunk.text || '', /999/)

    const overLimitPdf = await upload(
      'over-limit.pdf',
      createPdf(Array.from({ length: 501 }, (_, index) => `Page ${index + 1} has enough content to avoid OCR.`)),
      'application/pdf'
    )
    assert.equal(overLimitPdf.pageCount, 501)
    assert.equal(overLimitPdf.extractionStatus, 'partial')
    assert.match(overLimitPdf.extractionNote || '', /first 500 of 501 PDF pages/)
    assert.equal(overLimitPdf.chunkCount, 500)

    const textCanvas = createCanvas(800, 100)
    const context = textCanvas.getContext('2d')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, 800, 100)
    context.fillStyle = '#000'
    context.font = 'bold 62px Arial'
    context.fillText('SCANNED TOTAL 42', 12, 72)
    const scannedImage = textCanvas.toBuffer('image/jpeg')
    const scanned = await upload('scanned.pdf', createScannedPdf(scannedImage), 'application/pdf')
    assert.equal(scanned.pageCount, 1)
    assert.match(conversationFileService.search(owner, session, 'SCANNED TOTAL 42')[0]?.chunk.text || '', /42/)

    const markdown = await upload('long.md', Buffer.from(`# Long note\n\n${'Last section contains 9876. '.repeat(120)}`, 'utf8'), 'text/markdown')
    assert.ok(markdown.chunkCount > 1)
    assert.match(conversationFileService.search(owner, session, 'last section 9876')[0]?.chunk.text || '', /9876/)
    const summaryChunks = conversationFileService.search(owner, session, 'summarize the entire long note')
    assert.ok(summaryChunks.length > 1)
    assert.ok(summaryChunks.some((match) => match.chunk.chunkIndex > 1))

    const pixelCanvas = createCanvas(8, 8)
    const pixelContext = pixelCanvas.getContext('2d')
    pixelContext.fillStyle = '#fff'
    pixelContext.fillRect(0, 0, 8, 8)
    const image = await upload('pixel.png', pixelCanvas.toBuffer('image/png'), 'image/png')
    assert.equal(image.extractionStatus, 'image')
    const ocrImage = await upload('printed.png', textCanvas.toBuffer('image/png'), 'image/png')
    assert.match(conversationFileService.search(owner, session, 'printed scanned total')[0]?.chunk.text || '', /42/)
    assert.equal(conversationFileService.getVisionImages(owner, session).length, 2)
    assert.equal(conversationFileService.getVisionImages('another-owner', session).length, 0)

    await assert.rejects(upload('broken.pdf', Buffer.from('not a pdf')), /contents do not match/)
    await assert.rejects(
      upload('broken.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('broken image')])),
      /corrupted/
    )
    await assert.rejects(upload('unsupported.exe', Buffer.from('program')), /not supported/)

    const reloadedService = new ConversationFileService()
    assert.equal(reloadedService.listForSession(owner, session).length, 11)
    assert.equal(reloadedService.listForSession('another-owner', session).length, 0)

    const portProbe = net.createServer()
    await new Promise<void>((resolve, reject) => {
      portProbe.once('error', reject)
      portProbe.listen(0, '127.0.0.1', () => resolve())
    })
    const address = portProbe.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()))

    const root = process.cwd()
    mockModelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json')
        if (request.url === '/api/show') {
          response.end(JSON.stringify({ capabilities: ['completion', 'vision'] }))
          return
        }
        if (request.url === '/api/chat') {
          visionPayload = JSON.parse(body) as typeof visionPayload
          response.setHeader('Content-Type', 'application/x-ndjson')
          response.end(`${JSON.stringify({ message: { content: 'Local image answer' }, done: true })}\n`)
          return
        }
        response.statusCode = 404
        response.end('{}')
      })
    })
    await new Promise<void>((resolve, reject) => {
      mockModelServer?.once('error', reject)
      mockModelServer?.listen(0, '127.0.0.1', () => resolve())
    })
    const modelAddress = mockModelServer.address()
    assert.ok(modelAddress && typeof modelAddress !== 'string')

    const serverEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DATA_DIR: path.join(temporaryDirectory, 'api-data'),
      MEDIA_DIR: path.join(temporaryDirectory, 'api-media'),
      PORT: String(port),
      NODE_ENV: 'development',
      AI_PROVIDER: '',
    }
    delete serverEnvironment.NETLIFY
    delete serverEnvironment.AWS_LAMBDA_FUNCTION_NAME
    apiServer = spawn(process.execPath, [
      path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(root, 'server', 'server.ts'),
    ], { cwd: root, env: serverEnvironment, stdio: 'ignore' })
    const baseUrl = `http://127.0.0.1:${port}`
    let serverReady = false
    for (let attempt = 0; attempt < 50; attempt++) {
      if (apiServer.exitCode !== null) throw new Error('The isolated API server exited before becoming ready.')
      try {
        const health = await fetch(`${baseUrl}/api/health`)
        if (health.ok) {
          serverReady = true
          break
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    assert.equal(serverReady, true, 'The isolated API server should start.')

    const headers = { 'x-guest-id': 'file-api-test' }
    const created = await fetch(`${baseUrl}/api/chats`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Upload API test' }),
    })
    assert.equal(created.status, 200)
    const createdBody = await created.json() as { session: { id: string } }
    const form = new FormData()
    form.append('file', new Blob(['API file content mentions invoice amount 640.'], { type: 'text/plain' }), 'api.txt')
    const uploaded = await fetch(`${baseUrl}/api/chats/${createdBody.session.id}/files`, {
      method: 'POST',
      headers,
      body: form,
    })
    assert.equal(uploaded.status, 201)
    const uploadedBody = await uploaded.json() as { file: { id: string; name: string } }
    assert.equal(uploadedBody.file.name, 'api.txt')

    const stream = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'What is the invoice amount?',
        sessionId: createdBody.session.id,
        aiProvider: 'openai',
        searchMode: 'never',
      }),
    })
    const streamText = await stream.text()
    assert.match(streamText, /Uploaded files stay on this device/)

    const imageForm = new FormData()
    imageForm.append('file', new Blob([pixelCanvas.toBuffer('image/png')], { type: 'image/png' }), 'api-image.png')
    const uploadedImage = await fetch(`${baseUrl}/api/chats/${createdBody.session.id}/files`, {
      method: 'POST',
      headers,
      body: imageForm,
    })
    assert.equal(uploadedImage.status, 201)
    const uploadedImageBody = await uploadedImage.json() as { file: { id: string } }
    const imageStream = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Describe the uploaded image.',
        sessionId: createdBody.session.id,
        aiProvider: 'ollama',
        modelName: 'local-vision-mock',
        ollamaModel: 'local-vision-mock',
        ollamaBaseUrl: `http://127.0.0.1:${modelAddress.port}`,
        searchMode: 'never',
      }),
    })
    assert.match(await imageStream.text(), /Local image answer/)
    const imageMessage = visionPayload?.messages?.find((message) => message.role === 'user')
    assert.equal(imageMessage?.images?.length, 1)

    for (const fileId of [uploadedBody.file.id, uploadedImageBody.file.id]) {
      const removed = await fetch(
        `${baseUrl}/api/chats/${createdBody.session.id}/files/${fileId}`,
        { method: 'DELETE', headers }
      )
      assert.equal(removed.status, 200)
    }
    const listing = await fetch(`${baseUrl}/api/chats/${createdBody.session.id}/files`, { headers })
    const listingBody = await listing.json() as { files: unknown[] }
    assert.equal(listingBody.files.length, 0)
    console.log('Conversation file tests passed: TXT/MD, PDF pages and scanned OCR, DOCX, XLSX/XLS/CSV, image OCR, API privacy, scope, persistence, invalid files.')
  } finally {
    if (apiServer?.pid && apiServer.exitCode === null) {
      const exited = new Promise<void>((resolve) => apiServer?.once('exit', () => resolve()))
      apiServer.kill()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
    }
    if (mockModelServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        mockModelServer?.close((error) => error ? reject(error) : resolve())
      })
    }
    if (stopOcrWorker) await stopOcrWorker()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
