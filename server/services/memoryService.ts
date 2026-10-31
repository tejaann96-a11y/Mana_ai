import { dbService } from './dbService.js'

export interface MemoryItem {
  id: string
  userId?: string
  category: 'personal' | 'preference' | 'correction' | 'project'
  key: string
  value: string
  createdAt: string
  updatedAt: string
}

export interface FeedbackItem {
  id: string
  userId?: string
  messageId: string
  prompt: string
  response: string
  rating: 'thumbs_up' | 'thumbs_down'
  comment?: string
  timestamp: string
}

const SENSITIVE_KEY_BLOCKLIST = [
  /password/i,
  /api[_\s-]?key/i,
  /secret/i,
  /token/i,
  /private[_\s-]?key/i,
  /credit[_\s-]?card/i,
  /cvv/i,
  /ssn/i,
  /aadhar/i,
  /bank[_\s-]?account/i,
]

const SENSITIVE_VALUE_PATTERN = /^(sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9]{20,}|[A-Za-z0-9+/]{40,}={0,2})$/

const INTIMATE_CONTENT_GUARD = /\b(naked|nude|sex( with| me)?|intercourse|orgasm|masturbat|porn|condom|erect|penetrat)\b/i

class MemoryService {
  private memories: MemoryItem[] = []
  private feedbacks: FeedbackItem[] = []

  constructor() {
    this.loadData()
  }

  private loadData() {
    this.memories = dbService.getSync<MemoryItem[]>('memories', [])
    if (this.memories.length === 0) {
      this.memories = [
        {
          id: 'mem-default-1',
          category: 'preference',
          key: 'Communication Style',
          value: 'Warm, casual, like a trusted village friend. Direct answers first, natural emojis.',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]
      dbService.setSync('memories', this.memories)
    }
  }

  private saveMemories() {
    dbService.setSync('memories', this.memories)
  }

  public async refreshFromDb(): Promise<void> {
    try {
      this.memories = await dbService.getFresh<MemoryItem[]>('memories', this.memories)
    } catch {}
  }

  public async saveMemoriesAsync(): Promise<void> {
    await dbService.set('memories', this.memories)
  }

  public getMemories(userId?: string): MemoryItem[] {
    if (!userId) return [...this.memories]
    return this.memories.filter((m) => m.userId === userId || (!m.userId && m.category === 'preference' && m.id === 'mem-default-1'))
  }

  public addMemory(category: MemoryItem['category'], key: string, value: string, userId?: string): MemoryItem {
    const cleanKey = key.trim()
    const cleanValue = value.trim()

    // Block storage of sensitive keys and obvious credential values
    if (SENSITIVE_KEY_BLOCKLIST.some((re) => re.test(cleanKey))) {
      console.warn('[MemoryService] Blocked attempt to store sensitive key:', cleanKey)
      return { id: 'blocked', userId, category, key: cleanKey, value: '[blocked]', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    }
    if (SENSITIVE_VALUE_PATTERN.test(cleanValue)) {
      console.warn('[MemoryService] Blocked attempt to store credential-like value for key:', cleanKey)
      return { id: 'blocked', userId, category, key: cleanKey, value: '[blocked]', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    }

    const existingIndex = this.memories.findIndex(
      (m) =>
        m.key.toLowerCase().trim() === cleanKey.toLowerCase() &&
        (userId ? m.userId === userId : !m.userId)
    )

    const now = new Date().toISOString()

    if (existingIndex !== -1) {
      this.memories[existingIndex] = {
        ...this.memories[existingIndex],
        category,
        value: cleanValue,
        userId: userId || this.memories[existingIndex].userId,
        updatedAt: now,
      }
      this.saveMemories()
      return this.memories[existingIndex]
    }

    const newMemory: MemoryItem = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      userId,
      category,
      key: cleanKey,
      value: cleanValue,
      createdAt: now,
      updatedAt: now,
    }

    this.memories.unshift(newMemory)
    this.saveMemories()
    return newMemory
  }

  public updateMemory(id: string, updates: Partial<Pick<MemoryItem, 'category' | 'key' | 'value'>>): MemoryItem | null {
    const index = this.memories.findIndex((m) => m.id === id)
    if (index === -1) return null

    this.memories[index] = {
      ...this.memories[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    }

    this.saveMemories()
    return this.memories[index]
  }

  public deleteMemory(id: string): boolean {
    const initialLength = this.memories.length
    this.memories = this.memories.filter((m) => m.id !== id)
    if (this.memories.length !== initialLength) {
      this.saveMemories()
      return true
    }
    return false
  }

  public clearAllMemories(userId?: string): void {
    if (!userId) {
      this.memories = []
    } else {
      this.memories = this.memories.filter((m) => m.userId && m.userId !== userId)
    }
    this.saveMemories()
  }

  public saveFeedback(item: Omit<FeedbackItem, 'id' | 'timestamp'>, userId?: string): FeedbackItem {
    return this.recordFeedback(item, userId)
  }

  public recordFeedback(data: Omit<FeedbackItem, 'id' | 'timestamp'>, userId?: string): FeedbackItem {
    const item: FeedbackItem = {
      id: `fb-${Date.now()}`,
      userId,
      timestamp: new Date().toISOString(),
      ...data,
    }
    this.feedbacks.unshift(item)
    // Keep last 100 feedback entries
    if (this.feedbacks.length > 100) {
      this.feedbacks = this.feedbacks.slice(0, 100)
    }

    // If thumbs down with a correction/comment, automatically save a learned correction
    if (data.rating === 'thumbs_down' && data.comment) {
      this.addMemory('correction', `Feedback on "${data.prompt.slice(0, 30)}"`, data.comment, userId)
    }

    return item
  }

  public getFeedbacks(userId?: string): FeedbackItem[] {
    if (!userId) return [...this.feedbacks]
    return this.feedbacks.filter((f) => !f.userId || f.userId === userId)
  }

  /**
   * Retrieves relevant memory items matching the user's prompt
   */
  public getRelevantMemories(prompt: string, enabled = true, userId?: string): MemoryItem[] {
    if (!enabled || this.memories.length === 0) return []
    const lower = prompt.toLowerCase()
    const words = lower.split(/\s+/).filter((w) => w.length > 3)

    return this.memories.filter((mem) => {
      // User isolation: if userId specified and memory belongs to another user, exclude
      if (userId && mem.userId && mem.userId !== userId) return false

      // High-priority persistent preferences always apply (Language, Answer Style, Communication Style, Name)
      if (
        mem.category === 'preference' ||
        mem.category === 'personal' ||
        /^(preferred language|answer style|communication style|user's name|username)$/i.test(mem.key)
      ) {
        return true
      }

      const memText = (mem.key + ' ' + mem.value).toLowerCase()
      return words.some((w) => memText.includes(w))
    })
  }

  /**
   * Automatically detects personal information or explicit preferences stated in the prompt
   */
  public detectAndSaveUserPreferences(
    prompt: string,
    enabledOrUserId: boolean | string = true,
    maybeUserId?: string
  ): MemoryItem | null {
    const enabled = typeof enabledOrUserId === 'boolean' ? enabledOrUserId : true
    const userId = typeof enabledOrUserId === 'string' ? enabledOrUserId : maybeUserId
    if (!enabled) return null
    const clean = prompt.trim()
    const lower = clean.toLowerCase()

    // 0a. Explicit Language Persistence (e.g. "English only", "speak in English only", "Telugu only")
    if (
      /\b(english only|talk (only )?in english|speak (only )?in english|reply (only )?in english|use english only|chat in english)\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'Preferred Language', 'English only', userId)
    }

    if (
      /\b(telugu only|speak (only )?in telugu|reply (only )?in telugu|telugu lo (matladu|cheppu|reply)|use telugu only)\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'Preferred Language', 'Telugu', userId)
    }

    // 0b. Answer Length Preference (Concise vs Detailed)
    if (
      /\b(short answers?( only)?|keep (answers?|replies) short|give short answers?|be concise|concise answers?( only)?)\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'Answer Style', 'Concise (1–4 sentences by default)', userId)
    }

    if (
      /\b(detailed answers?( only)?|give detailed answers?|provide in-depth answers?)\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'Answer Style', 'Detailed explanations', userId)
    }

    // 0b-ext. English level preference persistence
    if (
      /\b(i prefer simple english|use simple english|always (use |reply in |speak )?simple english|simple english please)\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'languagePreference', 'simple_english', userId)
    }

    if (
      /\b(always (use |reply in |speak )?telugu|i prefer telugu|telugu (hi|preferred|always))\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'languagePreference', 'telugu', userId)
    }

    if (
      /\b(always (use |reply in |speak )?english|i prefer english|english (preferred|always))\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'languagePreference', 'english', userId)
    }

    // 0b-ext2. Answer length explicit preferences (new key names for wave 2)
    if (
      /\b(short answers? please|please (keep|give) (answers?|replies?) short|be brief please|brevity please)\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'answerLength', 'short', userId)
    }

    if (
      /\b(give me detailed answers?|detailed answers? please|explain everything|provide (full|detailed|in-depth) (answers?|explanations?))\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'answerLength', 'detailed', userId)
    }

    // 0c. Conversational Tone / Persona
    if (
      /\b(talk like a friend|be my friend|village friend|village buddy tone|friendly banter)\b/i.test(clean)
    ) {
      return this.addMemory('preference', 'Communication Style', 'Warm, relaxed village friend. Witty, open-minded, playful banter.', userId)
    }

    // 1. Name detection (e.g. "my name is Rahul", "call me Nagesh")
    const explicitNameMatch = clean.match(/(?:my name is|call me|myself|i am called|i'm called)\s+([A-Z][a-zA-Z0-9_-]+)/i)
    const selfNameMatch = !explicitNameMatch && clean.match(/^(?:i am|i'm)\s+([A-Z][a-zA-Z0-9_-]+)[.!]?$/i)
    const candidate = explicitNameMatch ? explicitNameMatch[1] : (selfNameMatch ? selfNameMatch[1] : null)

    if (candidate) {
      const lowerCandidate = candidate.toLowerCase()
      const nonNameWords = new Set([
        'sorry', 'glad', 'happy', 'tired', 'here', 'fine', 'good', 'ready',
        'asking', 'bored', 'sad', 'sick', 'sure', 'not', 'just', 'working',
        'trying', 'saying', 'telling', 'looking', 'waiting', 'reading',
        'learning', 'testing', 'using', 'online', 'busy', 'done', 'back'
      ])
      if (!nonNameWords.has(lowerCandidate) && !/(?:ing|ed|ly)$/i.test(lowerCandidate)) {
        // Single canonical key 'userName' — avoids double-write side effect
        return this.addMemory('personal', 'userName', candidate, userId)
      }
    }

    // 2. Preferences
    // Guard: do not auto-save explicit sexual/intimate conversation content as memory
    // (Placed after explicit preference checks so that preference-phrasing is saved first)
    if (INTIMATE_CONTENT_GUARD.test(clean)) return null

    const preferMatch = clean.match(/(?:i prefer|i like|always use|prefer to use)\s+([a-zA-Z0-9\s#+._-]+)/i)
    if (preferMatch && preferMatch[1].length < 40) {
      return this.addMemory('preference', 'Preference', preferMatch[1].trim(), userId)
    }

    // 3. Explicit correction ("Actually, ...", "No, it is ...")
    const correctionMatch = clean.match(/(?:actually,? it(?:'s| is)|no,? that(?:'s| is) wrong,?\s*(?:it is)?)\s+([a-zA-Z0-9\s#+._-]+)/i)
    if (correctionMatch) {
      return this.addMemory('correction', 'User Correction', correctionMatch[1].trim(), userId)
    }

    return null
  }

  public autoExtractMemories(prompt: string, response: string): MemoryItem[] {
    const extracted: MemoryItem[] = []
    const lower = prompt.toLowerCase()

    if (/my name is ([a-zA-Z0-9_\s]+)/i.test(prompt)) {
      const match = prompt.match(/my name is ([a-zA-Z0-9_\s]+)/i)
      if (match && match[1]) {
        // Use canonical key 'userName' to match detectAndSaveUserPreferences — avoids duplicate inconsistent entries
        extracted.push(this.addMemory('personal', 'userName', match[1].trim()))
      }
    }

    if (/i live in ([a-zA-Z0-9_\s,]+)/i.test(prompt) || /i am from ([a-zA-Z0-9_\s,]+)/i.test(prompt)) {
      const match = prompt.match(/(?:i live in|i am from) ([a-zA-Z0-9_\s,]+)/i)
      if (match && match[1]) {
        extracted.push(this.addMemory('personal', 'Location', match[1].trim()))
      }
    }

    if (/i prefer ([a-zA-Z0-9_\s,]+)/i.test(prompt)) {
      const match = prompt.match(/i prefer ([a-zA-Z0-9_\s,]+)/i)
      if (match && match[1]) {
        extracted.push(this.addMemory('preference', 'Preference', match[1].trim()))
      }
    }

    if (/remember that ([a-zA-Z0-9_\s,.]+)/i.test(prompt)) {
      const match = prompt.match(/remember that ([a-zA-Z0-9_\s,.]+)/i)
      if (match && match[1]) {
        extracted.push(this.addMemory('preference', 'Explicit Note', match[1].trim()))
      }
    }

    return extracted
  }
}

export const memoryService = new MemoryService()
