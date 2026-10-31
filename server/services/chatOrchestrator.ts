import { AppConfig, SearchEvidence, ImageSearchEvidence, MemoryItem, SearchMode } from '../types.js'
import { configService, resolveOllamaBaseUrl } from './configService.js'
import { authService } from './authService.js'
import { memoryService } from './memoryService.js'
import { documentService } from './documentService.js'
import { conversationFileService } from './conversationFileService.js'
import { classifyIntent } from './intentClassifier.js'
import { executeWebSearch } from './searchService.js'
import { generateAIResponse, getOllamaHeaders } from './aiService.js'
import { answerLocalDateTimeQuestion } from './dateTimeService.js'
import { executeImageSearch, extractImageSearchQuery } from './imageSearchService.js'

export interface ChatRequestOptions {
  prompt: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  searchMode?: SearchMode
  reasoningMode?: 'fast' | 'thinking'
  aiProvider?: 'ollama' | 'gemini' | 'openai' | 'groq' | 'builtin'
  modelName?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
  geminiApiKey?: string
  openaiApiKey?: string
  groqApiKey?: string
  authUser?: any
  clientId?: string
  sessionId?: string
  signal?: AbortSignal
}

export interface StreamEventCallbacks {
  onMemorySaved?: (memory: MemoryItem) => void
  onSearchStart?: (data: { query: string; reason: string; category: string }) => void
  onSearchStatus?: (data: { status: string; step: string }) => void
  onSearchResults?: (evidence: SearchEvidence) => void
  onImageSearchResults?: (evidence: ImageSearchEvidence) => void
  onProviderFallback?: (data: { from: 'ollama'; to: 'gemini'; message: string }) => void
  onToken?: (token: string) => void
  onDone?: (data: any) => void
  onError?: (error: Error) => void
}

export const MAX_PROMPT_LENGTH = 10000

/**
 * Unified Chat Orchestrator shared across Express local/production server
 * and Netlify Serverless Streaming functions.
 */
export async function orchestrateChat(
  options: ChatRequestOptions,
  callbacks?: StreamEventCallbacks
): Promise<{
  content: string
  searchEvidence?: SearchEvidence
  imageSearchEvidence?: ImageSearchEvidence
  isSearchPerformed: boolean
  intent: any
  memoriesUsed: string[]
  documentsUsed: string[]
  reasoningMode: string
  timings: {
    reqStart: number
    ttftMs: number
    totalMs: number
  }
}> {
  const reqStart = Date.now()
  const { prompt, history = [], searchMode: reqSearchMode, reasoningMode: reqReasoningMode, authUser, signal } = options

  // 1. Strict Server Input Validation
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Valid prompt string is required.')
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt exceeds maximum allowed length (${MAX_PROMPT_LENGTH} characters).`)
  }
  if (signal?.aborted) {
    throw signal.reason || new DOMException('The operation was aborted.', 'AbortError')
  }

  const cleanPrompt = prompt.trim()
  const fileOwnerId = options.clientId || 'guest'
  const sessionFiles = options.sessionId
    ? conversationFileService.listForSession(fileOwnerId, options.sessionId)
    : []
  const uploadedFileMatches = options.sessionId
    ? conversationFileService.search(fileOwnerId, options.sessionId, cleanPrompt, 8)
    : []
  const visionImages = options.sessionId
    ? conversationFileService.getVisionImages(fileOwnerId, options.sessionId)
    : []

  const localDateTimeAnswer = answerLocalDateTimeQuestion(cleanPrompt)
  if (localDateTimeAnswer) {
    const elapsed = Date.now() - reqStart
    const result = {
      content: localDateTimeAnswer,
      searchEvidence: undefined,
      isSearchPerformed: false,
      intent: {
        needsSearch: false,
        refinedQuery: cleanPrompt,
        reason: 'Answered directly from the server local date and time.',
        category: 'local_datetime',
        isDetailRequested: false,
      },
      memoriesUsed: [],
      documentsUsed: [],
      reasoningMode: 'fast',
      timings: {
        reqStart,
        ttftMs: elapsed,
        totalMs: elapsed,
      },
    }
    callbacks?.onToken?.(localDateTimeAnswer)
    callbacks?.onDone?.(result)
    return result
  }

  // 2. Resolve Config & Keys (Prioritizing secure server environment variables for shared deployments)
  const config = { ...configService.getConfig() }
  const validProviders = ['ollama', 'gemini', 'openai', 'groq', 'builtin'] as const
  if (process.env.AI_PROVIDER?.trim()) {
    config.aiProvider = validProviders.includes(process.env.AI_PROVIDER.trim() as typeof validProviders[number])
      ? process.env.AI_PROVIDER.trim() as typeof validProviders[number]
      : 'ollama'
  } else if (options.aiProvider !== undefined) {
    config.aiProvider = validProviders.includes(options.aiProvider)
      ? options.aiProvider
      : 'ollama'
  }
  if (options.modelName) {
    config.modelName = options.modelName
  }

  config.ollamaBaseUrl = resolveOllamaBaseUrl(
    config.ollamaBaseUrl,
    undefined,
    undefined,
    options.ollamaBaseUrl
  )

  if (options.ollamaModel) {
    config.ollamaModel = options.ollamaModel
  }

  if (sessionFiles.length) {
    if (config.aiProvider !== 'ollama' && config.aiProvider !== 'builtin') {
      throw new Error('Uploaded files stay on this device. Select local Ollama or Built-in AI to use them; cloud providers will not receive your files.')
    }
    if (visionImages.length && config.aiProvider !== 'ollama') {
      throw new Error('Image understanding requires a local vision-capable Ollama model. Your images were not sent to an external provider.')
    }
    if (config.aiProvider === 'ollama') {
      const baseUrl = config.ollamaBaseUrl || 'http://127.0.0.1:11434'
      let hostname: string
      try {
        hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
      } catch {
        throw new Error('The configured Ollama URL is invalid. Uploaded files were not sent.')
      }
      if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
        throw new Error('Uploaded files stay local. Configure Ollama at localhost to use private files; this request was not sent to a remote host.')
      }
      if (visionImages.length) {
        const modelName = options.ollamaModel || config.ollamaModel || config.modelName || process.env.OLLAMA_MODEL || 'qwen2.5:3b'
        let response: Response
        try {
          response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/show`, {
            method: 'POST',
            headers: {
              ...getOllamaHeaders(baseUrl),
              'Content-Type': 'application/json',
              ...(process.env.OLLAMA_API_KEY ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {}),
            },
            body: JSON.stringify({ model: modelName }),
            signal: AbortSignal.timeout(8_000),
          })
        } catch {
          throw new Error('Could not verify local image support in Ollama. Your image was not sent.')
        }
        if (!response.ok) {
          throw new Error(`Ollama could not verify image support for "${modelName}". Your image was not sent.`)
        }
        const modelInfo = await response.json() as { capabilities?: unknown }
        const capabilities = Array.isArray(modelInfo.capabilities)
          ? modelInfo.capabilities.filter((value): value is string => typeof value === 'string')
          : []
        if (!capabilities.includes('vision')) {
          throw new Error(`The local Ollama model "${modelName}" does not advertise vision support. Choose a vision-capable local model; your image was not sent.`)
        }
      }
    }
  }

  // Validate that an incoming client key is non-empty, genuine, and not a masked placeholder
  const isGenuineKey = (k?: string): boolean =>
    typeof k === 'string' && k.trim().length > 10 && !k.includes('••••') && !k.includes('****')

  // Check if authenticated user has a personal key saved in their account
  let userSavedKey: string | undefined
  if (authUser?.id) {
    const rawUser = authService.getUserById(authUser.id)
    if (rawUser?.geminiApiKey && isGenuineKey(rawUser.geminiApiKey)) {
      userSavedKey = rawUser.geminiApiKey.trim()
    }
  }

  // Gemini Key Resolution:
  // 1. Client-supplied custom key (BYOK in session) if genuine
  // 2. Account-stored user key if genuine
  // 3. Server environment variable GEMINI_API_KEY (shared deployment authority)
  // 4. Server config file key if genuine
  if (isGenuineKey(options.geminiApiKey)) {
    config.geminiApiKey = options.geminiApiKey!.trim()
  } else if (userSavedKey) {
    config.geminiApiKey = userSavedKey
  } else if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    config.geminiApiKey = process.env.GEMINI_API_KEY.trim()
  } else if (isGenuineKey(config.geminiApiKey)) {
    config.geminiApiKey = config.geminiApiKey.trim()
  } else {
    config.geminiApiKey = ''
  }

  // OpenAI Key Resolution:
  if (isGenuineKey(options.openaiApiKey)) {
    config.openaiApiKey = options.openaiApiKey!.trim()
  } else if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
    config.openaiApiKey = process.env.OPENAI_API_KEY.trim()
  } else if (isGenuineKey(config.openaiApiKey)) {
    config.openaiApiKey = config.openaiApiKey.trim()
  } else {
    config.openaiApiKey = ''
  }

  // Groq Key Resolution:
  if (isGenuineKey(options.groqApiKey)) {
    config.groqApiKey = options.groqApiKey!.trim()
  } else if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()) {
    config.groqApiKey = process.env.GROQ_API_KEY.trim()
  } else if (isGenuineKey(config.groqApiKey)) {
    config.groqApiKey = config.groqApiKey.trim()
  } else {
    config.groqApiKey = ''
  }

  const searchMode: SearchMode = reqSearchMode || config.searchMode || 'auto'
  const reasoningMode: 'fast' | 'thinking' = reqReasoningMode || (config.reasoningMode as any) || 'fast'
  const isMemoryEnabled = config.memoryEnabled !== false

  // 3. User Memory Detection & Retrieval
  const learnedMemory = memoryService.detectAndSaveUserPreferences(cleanPrompt, isMemoryEnabled, authUser?.id)
  if (learnedMemory && callbacks?.onMemorySaved) {
    callbacks.onMemorySaved(learnedMemory)
  }
  const relevantMemories = memoryService.getRelevantMemories(cleanPrompt, isMemoryEnabled, authUser?.id)

  // 4. Document RAG Retrieval
  const documentMatches = [
    ...uploadedFileMatches,
    ...documentService.searchKnowledge(cleanPrompt, 3),
  ]

  // 5. Context-Aware Intent Classification
  const intent = classifyIntent(cleanPrompt, history)
  const imageSearchQuery = extractImageSearchQuery(cleanPrompt)

  if (imageSearchQuery && !intent.isCorrectionOrFeedback && searchMode === 'never') {
    const elapsed = Date.now() - reqStart
    const result = {
      content: 'Web search is off, so I did not search for or load any external images. Turn search on in the composer tools to see real image results.',
      isSearchPerformed: false,
      intent,
      memoriesUsed: relevantMemories.map((memory) => memory.key),
      documentsUsed: documentMatches.map((document) => document.docTitle),
      reasoningMode,
      timings: { reqStart, ttftMs: elapsed, totalMs: elapsed },
    }
    callbacks?.onToken?.(result.content)
    callbacks?.onDone?.(result)
    return result
  }

  const shouldImageSearch = !!imageSearchQuery && searchMode !== 'never' && !intent.isCorrectionOrFeedback

  // Web search decision:
  // NEVER search if user is conversational, greetings, identity inquiries, or correcting/giving feedback
  const shouldSearch = shouldImageSearch || (
    searchMode !== 'never' &&
    !intent.isCorrectionOrFeedback &&
    (searchMode === 'always' || (searchMode === 'auto' && intent.needsSearch))
  )

  if (shouldImageSearch && imageSearchQuery) {
    callbacks?.onSearchStart?.({
      query: imageSearchQuery,
      reason: 'The user asked to see existing real-world images.',
      category: 'image_search',
    })
    callbacks?.onSearchStatus?.({
      status: `Searching for real images via ${config.searchProvider}...`,
      step: 'retrieving',
    })
    const imageSearchEvidence = await executeImageSearch(
      imageSearchQuery,
      config.searchProvider,
      {
        tavily: config.tavilyApiKey,
        serper: config.serperApiKey,
        brave: config.braveApiKey,
      },
      signal,
    )
    if (signal?.aborted) {
      throw signal.reason || new DOMException('The operation was aborted.', 'AbortError')
    }
    callbacks?.onImageSearchResults?.(imageSearchEvidence)
    const count = imageSearchEvidence.results.length
    const content = count
      ? `Here ${count === 1 ? 'is' : 'are'} ${count} image ${count === 1 ? 'result' : 'results'} for “${imageSearchQuery}”. These are existing web images, not AI-generated. Please check the source’s usage rights before reusing them.`
      : `I couldn’t retrieve usable images for “${imageSearchQuery}”. ${imageSearchEvidence.errorMessage || 'Try another search provider or query.'}`
    const elapsed = Date.now() - reqStart
    const result = {
      content,
      imageSearchEvidence,
      isSearchPerformed: true,
      intent,
      memoriesUsed: relevantMemories.map((memory) => memory.key),
      documentsUsed: documentMatches.map((document) => document.docTitle),
      reasoningMode,
      timings: { reqStart, ttftMs: elapsed, totalMs: elapsed },
    }
    callbacks?.onToken?.(content)
    callbacks?.onDone?.(result)
    return result
  }

  let searchEvidence: SearchEvidence | undefined

  if (shouldSearch) {
    if (callbacks?.onSearchStart) {
      callbacks.onSearchStart({
        query: intent.refinedQuery,
        reason: intent.reason,
        category: intent.category,
      })
    }
    if (callbacks?.onSearchStatus) {
      callbacks.onSearchStatus({
        status: `Searching live web via ${config.searchProvider}...`,
        step: 'retrieving',
      })
    }

    try {
      searchEvidence = await executeWebSearch(
        intent.refinedQuery,
        config.searchProvider,
        {
          tavily: config.tavilyApiKey,
          serper: config.serperApiKey,
          brave: config.braveApiKey,
          signal,
        }
      )
    } catch (searchErr: any) {
      if (signal?.aborted) {
        throw signal.reason || searchErr
      }
      console.warn('[Orchestrator] Web search warning (continuing with LLM):', searchErr.message)
    }

    if (signal?.aborted) {
      throw signal.reason || new DOMException('The operation was aborted.', 'AbortError')
    }

    if (callbacks?.onSearchStatus) {
      callbacks.onSearchStatus({
        status: 'Filtering and ranking search results...',
        step: 'filtering',
      })
    }
    if (searchEvidence && callbacks?.onSearchResults) {
      callbacks.onSearchResults(searchEvidence)
    }
  }

  if (shouldSearch && !searchEvidence?.results.length) {
    const elapsed = Date.now() - reqStart
    const content = 'I couldn’t verify this from the current search results. Please try again or narrow the question.'
    const result = {
      content,
      searchEvidence,
      isSearchPerformed: true,
      intent,
      memoriesUsed: relevantMemories.map((memory) => memory.key),
      documentsUsed: documentMatches.map((document) => document.docTitle),
      reasoningMode,
      provider: config.aiProvider || 'ollama',
      model: config.aiProvider === 'ollama'
        ? config.ollamaModel || config.modelName || 'qwen2.5:3b'
        : config.modelName || config.ollamaModel || 'qwen2.5:3b',
      timings: { reqStart, ttftMs: elapsed, totalMs: elapsed },
    }
    callbacks?.onToken?.(content)
    callbacks?.onDone?.(result)
    return result
  }

  if (callbacks?.onSearchStatus) {
    callbacks.onSearchStatus({
      status: reasoningMode === 'thinking' ? 'Deep reasoning & calculating...' : 'Thinking...',
      step: 'generating',
    })
  }

  let firstTokenTime: number | null = null
  let accumulatedContent = ''
  let handledProvider = config.aiProvider || 'ollama'
  let handledModel = config.aiProvider === 'ollama'
    ? config.ollamaModel || config.modelName || 'qwen2.5:3b'
    : config.modelName || config.ollamaModel || 'qwen2.5:3b'

  const onTokenHandler = (token: string) => {
    if (!firstTokenTime) {
      firstTokenTime = Date.now() - reqStart
    }
    accumulatedContent += token
    if (callbacks?.onToken) {
      callbacks.onToken(token)
    }
  }

  // 6. Generate AI Response
  const content = await generateAIResponse({
    prompt: cleanPrompt,
    history,
    searchEvidence,
    memories: relevantMemories,
    isDetailRequested: intent.isDetailRequested,
    config,
    reasoningMode,
    documentMatches,
    images: visionImages.map((image) => image.data),
    allowProviderFallback: sessionFiles.length === 0 && visionImages.length === 0,
    signal,
    onToken: onTokenHandler,
    onProviderFallback: (data) => callbacks?.onProviderFallback?.(data),
    onProviderUsed: (provider, modelName) => {
      handledProvider = provider as typeof handledProvider
      handledModel = modelName
    },
  })

  if (signal?.aborted) {
    throw signal.reason || new DOMException('The operation was aborted.', 'AbortError')
  }

  const totalTime = Date.now() - reqStart
  const resultData = {
    content: accumulatedContent || content,
    searchEvidence,
    isSearchPerformed: shouldSearch || !!searchEvidence,
    intent,
    memoriesUsed: relevantMemories.map((m) => m.key),
    documentsUsed: documentMatches.map((d) => d.docTitle),
    reasoningMode,
    provider: handledProvider,
    model: handledModel,
    timings: {
      reqStart,
      ttftMs: firstTokenTime || totalTime,
      totalMs: totalTime,
    },
  }

  if (callbacks?.onDone) {
    callbacks.onDone(resultData)
  }

  return resultData
}
