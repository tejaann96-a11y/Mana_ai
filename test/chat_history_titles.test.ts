import assert from 'node:assert/strict'
import { chatHistoryService } from '../server/services/chatHistoryService.js'

const userId = 'title-test-user'
const session = chatHistoryService.createSession(userId, 'hi')
const firstTurn = [
  { id: 'user-1', role: 'user' as const, content: 'hi', timestamp: 1 },
]

chatHistoryService.saveMessages(userId, session.id, firstTurn)
session.title = 'Hi'
session.titleManuallyRenamed = undefined

const secondTurn = [
  ...firstTurn,
  { id: 'assistant-1', role: 'assistant' as const, content: 'Hello!', timestamp: 2 },
  { id: 'user-2', role: 'user' as const, content: 'Can you explain how CUDA works on my RTX 4060?', timestamp: 3 },
]
chatHistoryService.saveMessages(userId, session.id, secondTurn)

assert.equal(session.title, 'How CUDA works on my RTX 4060')
assert.equal(session.titleManuallyRenamed, false)

chatHistoryService.renameSession(userId, session.id, 'GPU notes')
chatHistoryService.saveMessages(userId, session.id, [
  ...secondTurn,
  { id: 'assistant-2', role: 'assistant' as const, content: 'CUDA runs GPU workloads.', timestamp: 4 },
  { id: 'user-3', role: 'user' as const, content: 'Explain the memory model too.', timestamp: 5 },
])

assert.equal(session.title, 'GPU notes')
assert.equal(session.titleManuallyRenamed, true)
assert.equal(chatHistoryService.deleteSession(userId, session.id), true)
console.log('Chat history title persistence checks passed.')
