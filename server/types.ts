export type AIProvider = 'ollama' | 'builtin' | 'gemini' | 'openai' | 'groq'
export type SearchProvider = 'duckduckgo' | 'tavily' | 'serper' | 'brave'
export type SearchMode = 'auto' | 'always' | 'never'
export type EmojiDensity = 'concise' | 'moderate' | 'minimal'

export type VoiceLanguage = 'en-US' | 'en-IN' | 'te-IN' | 'hi-IN'

export interface VoiceSettings {
  voiceMode: boolean
  language: VoiceLanguage
  rate: number
  pitch: number
  voiceURI?: string
}

export type ChatMode = 'chat' | 'image' | 'video'

export interface GeneratedImageMetadata {
  id?: string
  url: string
  prompt: string
  revisedPrompt?: string
  aspectRatio: '1:1' | '16:9' | '9:16'
  quality: 'standard' | 'hd'
  provider: string
  width?: number
  height?: number
  createdAt: string
  negativePrompt?: string
  seed?: number
  base64Data?: string
  workflowId?: string
  model?: string
  steps?: number
  cfgScale?: number
}

export interface ProviderRestrictions {
  name: string
  pricing: string
  durationLimit: string
  resolution: string
  docsUrl: string
  supportedAspectRatios: string[]
}

export interface VideoJobMetadata {
  jobId: string
  prompt: string
  provider: 'luma' | 'replicate' | 'runway' | 'pollinations' | 'selfhosted'
  status: 'queued' | 'processing' | 'completed' | 'failed'
  progress?: number
  videoUrl?: string
  thumbnailUrl?: string
  aspectRatio: '16:9' | '9:16' | '1:1'
  duration: number
  error?: string
  externalId?: string
  createdAt: string
  updatedAt: string
  providerRestrictions?: ProviderRestrictions
}

export interface AppConfig {
  aiProvider: AIProvider
  searchProvider: SearchProvider
  searchMode: SearchMode
  ollamaBaseUrl?: string
  ollamaModel?: string
  geminiApiKey?: string
  openaiApiKey?: string
  groqApiKey?: string
  huggingfaceApiKey?: string
  tavilyApiKey?: string
  serperApiKey?: string
  braveApiKey?: string
  lumaApiKey?: string
  replicateApiKey?: string
  runwayApiKey?: string
  selfHostedImageUrl?: string
  selfHostedVideoUrl?: string
  supabaseUrl?: string
  supabaseAnonKey?: string
  imageProvider?: 'openai' | 'pollinations' | 'huggingface' | 'selfhosted' | 'comfyui'
  videoProvider?: 'luma' | 'replicate' | 'runway' | 'selfhosted'
  comfyuiBaseUrl?: string
  comfyuiEnabled?: boolean
  comfyuiModel?: string
  comfyuiWorkflowPath?: string
  comfyuiWorkflowId?: string
  comfyuiOutputFolder?: string
  comfyuiWidth?: number
  comfyuiHeight?: number
  comfyuiCount?: number
  comfyuiSteps?: number
  comfyuiCfgScale?: number
  modelName: string
  systemPrompt: string
  maxShortSentences: number
  emojiDensity: EmojiDensity
  reasoningMode?: 'fast' | 'thinking'
  memoryEnabled?: boolean
  voiceSettings?: VoiceSettings
  theme?: 'system' | 'light' | 'dark'
}

export interface SearchResultItem {
  id: string
  title: string
  url: string
  snippet: string
  domain: string
  publishedDate?: string
  relevanceScore?: number
  isOfficialOrReputable?: boolean
}

export interface SearchEvidence {
  query: string
  provider: SearchProvider
  results: SearchResultItem[]
  totalFound: number
  searchedAt: string
  tookMs: number
  errorMessage?: string
}

export interface ImageSearchResult {
  id: string
  title: string
  imageUrl: string
  thumbnailUrl: string
  sourceUrl: string
  sourceDomain: string
  license?: string
}

export interface ImageSearchEvidence {
  query: string
  provider: SearchProvider
  results: ImageSearchResult[]
  searchedAt: string
  tookMs: number
  errorMessage?: string
}

export type IntentCategory =
  | 'conversational'
  | 'correction_feedback'
  | 'contextual_followup'
  | 'topic_change'
  | 'clarification'
  | 'general_knowledge'
  | 'coding'
  | 'news'
  | 'sports'
  | 'weather'
  | 'pricing'
  | 'explicit_search'

export interface IntentClassification {
  needsSearch: boolean
  refinedQuery: string
  reason: string
  category: IntentCategory
  isDetailRequested: boolean
  isCorrectionOrFeedback?: boolean
  isFollowUp?: boolean
  contextualTopic?: string
  correctedEntity?: string
  originalQuery?: string
  englishLevel?: 'simple' | 'intermediate' | 'advanced' | 'professional' | 'conversational' | 'learning'
}

export type IntentInfo = IntentClassification

export interface ChatMessage {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: number
  attachments?: Array<{
    id: string
    name: string
    mimeType: string
    sizeBytes: number
    uploadedAt: string
    extractionStatus: 'complete' | 'partial' | 'image'
    extractionNote?: string
    pageCount?: number
    worksheets?: Array<{ name: string; hidden: boolean }>
    chunkCount: number
  }>
  searchEvidence?: SearchEvidence
  imageSearchEvidence?: ImageSearchEvidence
  isSearchPerformed?: boolean
  feedback?: 'thumbs_up' | 'thumbs_down'
}
