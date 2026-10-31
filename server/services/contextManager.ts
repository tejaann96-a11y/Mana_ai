import { MemoryItem } from '../types.js'

export interface OptimizedContext {
  sanitizedHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  historySummary?: string
  totalEstimatedTokens: number
  memoriesUsed: MemoryItem[]
  resolvedRefs?: string
}

/**
 * Estimates token count from text using character heuristic (~4 characters per token)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Scans the last 4 messages for pronoun/role antecedents, topic noun phrases,
 * and URLs or code snippets. Returns a concise 'Recent context: ...' string
 * to prepend to system prompts, or undefined if nothing useful is found.
 */
function extractResolvedRefs(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): string | undefined {
  const last4 = messages.slice(-4)
  const combined = last4.map((m) => m.content).join('\n')

  const parts: string[] = []

  // 1. Person/pronoun subject — look for "she said", "he wants", "my girlfriend" etc.
  const pronounRoleMatch = combined.match(
    /\b(she|he|her|his|my (?:girlfriend|boyfriend|wife|husband|boss|friend|sister|brother|mom|dad|teacher|manager))\b/i
  )
  if (pronounRoleMatch) {
    // Try to find a proper noun near the match for added context
    const vicinity = combined.slice(
      Math.max(0, combined.indexOf(pronounRoleMatch[0]) - 40),
      combined.indexOf(pronounRoleMatch[0]) + 80
    )
    const properNoun = vicinity.match(/\b([A-Z][a-z]{2,})\b/)
    const antecedent = pronounRoleMatch[1]
    const entity = properNoun ? properNoun[1] : 'previous person mentioned'
    parts.push(`${antecedent} = ${entity}`)
  }

  // 2. Topic noun phrase — last capitalized multi-word or single-word noun from user turns,
  //    with fallback to significant lowercase words (for Teluglish / all-lowercase conversations)
  const stopwords = new Set(['I', 'The', 'My', 'Your', 'He', 'She', 'They', 'We', 'It', 'This', 'That', 'A', 'An'])
  const lowercaseStopwords = new Set(['i', 'the', 'my', 'your', 'he', 'she', 'they', 'we', 'it', 'this', 'that', 'a', 'an', 'is', 'are', 'was', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'about', 'and', 'or', 'but', 'so', 'if', 'can', 'will', 'would', 'should', 'could', 'may', 'might', 'what', 'how', 'why', 'when', 'where', 'who', 'which', 'please', 'tell', 'me', 'you', 'hi', 'hello', 'ok', 'okay', 'no', 'yes', 'not', 'any', 'all', 'just', 'also', 'like', 'want', 'need', 'know', 'go', 'get', 'give'])
  let lastTopic: string | undefined
  for (const msg of last4) {
    if (msg.role !== 'user') continue
    // First try: capitalized noun phrases (proper nouns, named entities)
    const nounMatches = [...msg.content.matchAll(/\b([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+){0,3})\b/g)]
    for (const m of nounMatches) {
      if (!stopwords.has(m[1].split(' ')[0])) {
        lastTopic = m[1]
      }
    }
    // Fallback: if no capitalized topic found yet, extract significant lowercase content words
    if (!lastTopic) {
      const words = msg.content.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !lowercaseStopwords.has(w) && /^[a-z]/.test(w))
      if (words.length > 0) {
        lastTopic = words[words.length - 1]
      }
    }
  }
  if (lastTopic) {
    parts.push(`Topic: ${lastTopic}`)
  }

  // 3. URL or code snippet from last 4 messages
  const urlMatch = combined.match(/https?:\/\/[^\s]{10,}/)
  if (urlMatch) {
    parts.push(`URL: ${urlMatch[0].slice(0, 80)}`)
  } else {
    // Look for code block or code token
    const codeBlock = combined.match(/```[\s\S]*?```/)
    if (codeBlock) {
      parts.push(`Code: ${codeBlock[0].slice(0, 80).replace(/\n/g, ' ')}`)
    } else {
      const codeToken = combined.match(/\b(function|def|class|import|const|let|var)\s+\w+/)
      if (codeToken) {
        parts.push(`Code: ${codeToken[0].slice(0, 80)}`)
      }
    }
  }

  if (parts.length === 0) return undefined
  return 'Recent context: ' + parts.join('. ')
}

/**
 * Optimizes chat history context:
 * 1. Deduplicates consecutive identical messages
 * 2. Applies sliding window: keeps the most recent 8-10 messages intact
 * 3. Compacts older messages (>10) into a concise context summary
 * 4. Caps individual historical message length to prevent past dumps from bloating context
 * 5. Enforces an overall token budget (default 2500 tokens)
 */
export function optimizeConversationContext(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  memories: MemoryItem[] = [],
  maxTokenBudget: number = 3500
): OptimizedContext {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      sanitizedHistory: [],
      totalEstimatedTokens: 0,
      memoriesUsed: memories.slice(0, 3),
    }
  }

  // 1. Clean and deduplicate history
  const cleanHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const msg of history) {
    if (!msg || typeof msg.content !== 'string') continue
    const trimmed = msg.content.trim()
    if (!trimmed) continue

    // Deduplicate exact consecutive duplicates
    const last = cleanHistory[cleanHistory.length - 1]
    if (last && last.role === msg.role && last.content === trimmed) {
      continue
    }

    cleanHistory.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: trimmed,
    })
  }

  // 2. Sliding Window: Separate into recent window (last 12 messages) and older history
  const RECENT_WINDOW_SIZE = 12
  const olderMessages = cleanHistory.slice(0, Math.max(0, cleanHistory.length - RECENT_WINDOW_SIZE))
  const recentMessages = cleanHistory.slice(-RECENT_WINDOW_SIZE)

  // 3. Compact older messages into a brief recap if conversation is long
  let historySummary: string | undefined
  if (olderMessages.length > 0) {
    const topics: string[] = []
    const entities: string[] = []
    const entityPattern = /\b([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})*)\b/g

    for (const m of olderMessages) {
      if (m.role === 'user' && m.content.length > 3) {
        const snippet = m.content.slice(0, 60).replace(/\n/g, ' ')
        topics.push(snippet)
      }
      // Extract named entities from both user and assistant messages
      const matches = m.content.match(entityPattern)
      if (matches) {
        for (const match of matches) {
          if (
            match.length > 3 &&
            !entities.includes(match) &&
            !/^(The|This|That|These|Those|When|What|Where|Which|How|Why|And|But|For|With|From|Into|Over|User|Assistant|Mana)$/.test(match)
          ) {
            entities.push(match)
          }
        }
      }
    }

    if (topics.length > 0) {
      historySummary = `[Earlier conversation: User discussed: ${topics.slice(-6).join('; ')}.`
      if (entities.length > 0) {
        historySummary += ` Entities mentioned: ${entities.slice(0, 10).join(', ')}.`
      }
      historySummary += `]`
    }
  }

  // 4. Cap individual older messages within the recent window (up to 2000 chars)
  const sanitizedHistory = recentMessages.map((msg, index) => {
    const isVeryRecent = index >= recentMessages.length - 2
    const maxLength = isVeryRecent ? 2500 : 1500
    if (msg.content.length > maxLength) {
      return {
        role: msg.role,
        content: msg.content.slice(0, maxLength) + '... [truncated for context efficiency]',
      }
    }
    return msg
  })

  // 5. Enforce token budget from oldest to newest
  let currentTokenCount = estimateTokens(historySummary || '')
  const budgetCompliantHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []

  // Iterate backwards (most recent messages have highest priority)
  for (let i = sanitizedHistory.length - 1; i >= 0; i--) {
    const msg = sanitizedHistory[i]
    const msgTokens = estimateTokens(msg.content)
    if (currentTokenCount + msgTokens <= maxTokenBudget) {
      budgetCompliantHistory.unshift(msg)
      currentTokenCount += msgTokens
    } else {
      break
    }
  }

  // Cap memories to the top 5 most relevant items
  const memoriesUsed = memories.slice(0, 5)

  // Extract resolved references from last 4 messages
  const resolvedRefs = extractResolvedRefs(cleanHistory.slice(-4))

  return {
    sanitizedHistory: budgetCompliantHistory,
    historySummary,
    totalEstimatedTokens: currentTokenCount,
    memoriesUsed,
    resolvedRefs,
  }
}
