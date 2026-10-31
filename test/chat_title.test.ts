import { deriveConversationTitle } from '../server/services/chatTitleService.js'
import { ChatMessage } from '../server/types.js'

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`)
  } else {
    console.error(`  ❌ ${label}: expected "${expected}", got "${actual}"`)
    process.exitCode = 1
  }
}

console.log('\n[Chat titles] choose a meaningful topic from early user messages')
{
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Can you explain how CUDA works on my RTX 4060?' },
  ] as ChatMessage[]
  assertEqual(deriveConversationTitle(messages), 'How CUDA works on my RTX 4060', 'a greeting does not become the conversation topic')
}

console.log('\n[Chat titles] remove leading request boilerplate and bound title length')
{
  assertEqual(
    deriveConversationTitle([{ role: 'user', content: 'Please tell me about local ComfyUI workflows.' }] as ChatMessage[]),
    'Local ComfyUI workflows.',
    'request boilerplate is removed'
  )
  const title = deriveConversationTitle([{ role: 'user', content: 'word '.repeat(30) }] as ChatMessage[])
  assertEqual(title.length <= 58, true, 'long titles are bounded')
}
