import { ChatMessage } from '../types.js'

const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'give', 'hello', 'hey', 'hi', 'how',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'tell',
  'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which',
  'who', 'why', 'with', 'would', 'you', 'your',
])

function cleanPrompt(prompt: string): string {
  return prompt
    .trim()
    .replace(/^(please\s+)?(can|could|would)\s+you\s+/i, '')
    .replace(/^(please\s+)?(tell me about|tell me|explain|describe|help me understand)\s+/i, '')
    .replace(/^(please\s+)?(what is|what are|who is|how do i|how can i)\s+/i, '')
    .replace(/[?!]+$/g, '')
    .trim()
}

function scorePrompt(prompt: string): number {
  const words = prompt.toLowerCase().match(/[a-z0-9]+/g) || []
  const topicWords = words.filter((word) => !TITLE_STOP_WORDS.has(word))
  return topicWords.length * 10 + Math.min(prompt.length, 100) / 100
}

function titleCaseFirstLetter(value: string): string {
  return value ? value[0].toLocaleUpperCase() + value.slice(1) : value
}

export function deriveConversationTitle(messages: ChatMessage[]): string {
  const candidates = messages
    .filter((message) => message.role === 'user' && typeof message.content === 'string')
    .slice(0, 6)
    .map((message) => cleanPrompt(message.content))
    .filter((prompt) => prompt.length > 0)

  if (!candidates.length) return 'New Conversation'

  const bestPrompt = candidates
    .map((prompt) => ({ prompt, score: scorePrompt(prompt) }))
    .sort((a, b) => b.score - a.score)[0].prompt

  const words = bestPrompt.split(/\s+/)
  const shortened = words.length > 9 ? `${words.slice(0, 9).join(' ')}…` : bestPrompt
  const bounded = shortened.length > 58 ? `${shortened.slice(0, 55).trimEnd()}…` : shortened
  return titleCaseFirstLetter(bounded)
}
