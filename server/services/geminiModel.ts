export const DEFAULT_GEMINI_CHAT_MODEL = 'gemini-3.8-flash'

const NON_CHAT_MODEL_MARKERS =
  /(?:^|[-_])(tts|audio|image|imagen|embedding|embed|transcription|speech|veo|music|live)(?:[-_]|$)/i

export function isGeminiChatModel(modelName: string): boolean {
  const normalized = modelName.replace(/^models\//i, '').trim()
  return /^gemini-/i.test(normalized) && !NON_CHAT_MODEL_MARKERS.test(normalized)
}

export function resolveGeminiChatModel(requestedModel?: string): string {
  const modelName =
    process.env.GEMINI_MODEL?.trim() ||
    requestedModel?.trim() ||
    DEFAULT_GEMINI_CHAT_MODEL
  const normalized = modelName.replace(/^models\//i, '').trim()

  if (!isGeminiChatModel(normalized)) {
    throw new Error(
      `GEMINI_MODEL must be a Gemini conversational text model. Configure GEMINI_MODEL=${DEFAULT_GEMINI_CHAT_MODEL}; TTS, audio, image-generation, embedding, and other specialized models cannot be used for chat.`
    )
  }

  return normalized
}
