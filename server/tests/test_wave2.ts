/**
 * Wave 2 Upgrade Test Suite — Mana AI
 * Tests: Adaptive English level detection, search over-trigger guards,
 * memory persistence (language pref, answer length, cross-user isolation).
 *
 * Run: npx tsx server/tests/test_wave2.ts
 */
import assert from 'node:assert'
import { classifyIntent } from '../services/intentClassifier.js'
import { memoryService } from '../services/memoryService.js'

console.log('=== MANA AI WAVE 2 UPGRADE TESTS ===\n')

let passedCount = 0
let failedCount = 0

function runTest(name: string, fn: () => void | Promise<void>) {
  const result = fn()
  if (result instanceof Promise) {
    result
      .then(() => {
        console.log(`[PASS] ${name}`)
        passedCount++
      })
      .catch((err: any) => {
        console.error(`[FAIL] ${name}`)
        console.error(`       Error: ${err.message}`)
        failedCount++
      })
    return result
  }
  try {
    fn()
    console.log(`[PASS] ${name}`)
    passedCount++
  } catch (err: any) {
    console.error(`[FAIL] ${name}`)
    console.error(`       Error: ${err.message}`)
    failedCount++
  }
}

// Test 1: Adaptive English — simple
runTest('Test 1: "explain in simple English" → englishLevel=simple', () => {
  const intent = classifyIntent('explain in simple English', [])
  assert.strictEqual(intent.englishLevel, 'simple', 'Must detect simple English level')
})

// Test 2: Adaptive English — professional
runTest('Test 2: "write a professional email" → englishLevel=professional', () => {
  const intent = classifyIntent('write a professional email', [])
  assert.strictEqual(intent.englishLevel, 'professional', 'Must detect professional English level')
})

// Test 3: Adaptive English — learning
runTest('Test 3: "teach me English" → englishLevel=learning', () => {
  const intent = classifyIntent('teach me English', [])
  assert.strictEqual(intent.englishLevel, 'learning', 'Must detect learning English level')
})

// Test 4: General knowledge — Hyderabad
runTest('Test 4: "Do you know Hyderabad?" → needsSearch=false', () => {
  const intent = classifyIntent('Do you know Hyderabad?', [])
  assert.strictEqual(intent.needsSearch, false, 'General knowledge query must NOT trigger web search')
})

// Test 5: General knowledge — Sachin Tendulkar
runTest('Test 5: "Tell me about Sachin Tendulkar" → needsSearch=false', () => {
  const intent = classifyIntent('Tell me about Sachin Tendulkar', [])
  assert.strictEqual(intent.needsSearch, false, 'Famous person general knowledge must NOT trigger web search')
})

// Test 6: Short message
runTest('Test 6: short message "ok" → needsSearch=false', () => {
  const intent = classifyIntent('ok', [])
  assert.strictEqual(intent.needsSearch, false, 'Short 2-char message must NOT trigger web search')
})

// Test 7: Personal/relationship question
runTest('Test 7: "my girlfriend is upset, what should I do?" → category=conversational, needsSearch=false', () => {
  const intent = classifyIntent('my girlfriend is upset, what should I do?', [])
  assert.strictEqual(intent.needsSearch, false, 'Personal question must NOT trigger web search')
  assert.strictEqual(intent.category, 'conversational', 'Personal question must be conversational')
})

// Test 8: Memory save: 'I prefer simple English' → languagePreference=simple_english
runTest('Test 8: "I prefer simple English" saves languagePreference=simple_english', () => {
  const userId = 'test-wave2-lang'
  memoryService.clearAllMemories(userId)
  memoryService.detectAndSaveUserPreferences('I prefer simple English', userId)
  const memories = memoryService.getMemories(userId)
  const found = memories.find((m) => m.key === 'languagePreference' && m.userId === userId)
  assert(found !== undefined, 'languagePreference memory must be saved')
  assert.strictEqual(found!.value, 'simple_english', 'Value must be simple_english')
})

// Test 9: Memory scoped retrieval
runTest('Test 9: userId-scoped memory retrieval', () => {
  const userId = 'test-wave2'
  memoryService.addMemory('preference', 'testKey-wave2', 'wave2-value', userId)
  const memories = memoryService.getMemories(userId)
  const found = memories.find((m) => m.key === 'testKey-wave2' && m.userId === userId)
  assert(found !== undefined, 'Memory saved for test-wave2 must be retrievable')
  assert.strictEqual(found!.value, 'wave2-value', 'Value must match')
})

// Test 10: Cross-user memory isolation
runTest('Test 10: cross-user isolation — user-A memory not visible to user-B', () => {
  const uniqueKey = `Wave2IsolationKey-${Date.now()}`
  memoryService.addMemory('preference', uniqueKey, 'OnlyForWave2A', 'wave2-user-A')
  const userBMemories = memoryService.getMemories('wave2-user-B')
  const leaked = userBMemories.find((m) => m.key === uniqueKey && m.userId === 'wave2-user-A')
  assert(leaked === undefined, 'wave2-user-B must NOT see wave2-user-A memories')
})

// Test 11: Fix C ordering hazard — live-data "what is X" query must still reach search
runTest('Test 11: "what is the gold rate" → needsSearch=true (Fix C ordering guard)', () => {
  const intent = classifyIntent('what is the gold rate', [])
  assert.strictEqual(intent.needsSearch, true, '"what is the gold rate" must trigger web search — not be suppressed by Fix C general inquiry guard')
})

// Test 12: Fix D regression guard — "I need the latest cricket score" must still trigger search
runTest('Test 12: "I need the latest cricket score" → needsSearch=true (Fix D over-suppression guard)', () => {
  const intent = classifyIntent('I need the latest cricket score', [])
  assert.strictEqual(intent.needsSearch, true, '"I need the latest cricket score" must trigger web search — Fix D must NOT block time-sensitive queries')
})

// Test 13: Conversational englishLevel from casual/slang message
runTest('Test 13: "sup bro whats good" → englishLevel=conversational (tone heuristic)', () => {
  const intent = classifyIntent('sup bro whats good', [])
  assert.strictEqual(intent.englishLevel, 'conversational', 'Casual slang message must detect conversational English level')
})

// Final result output
setTimeout(() => {
  console.log(`\n=== RESULTS: ${passedCount} PASSED, ${failedCount} FAILED ===\n`)
  if (failedCount > 0) {
    process.exit(1)
  } else {
    console.log('All wave 2 upgrade tests passed! 🎉')
  }
}, 200)
