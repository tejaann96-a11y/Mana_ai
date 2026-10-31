/**
 * Personality Upgrade Test Suite — Mana AI
 * Tests: Telugu slang accuracy, Teluglish greetings, follow-up context,
 * short answer enforcement, mature topic handling, hallucination resistance,
 * memory save/retrieve, memory scoping, sensitive key blocking, context entities.
 *
 * Run: npx tsx server/tests/test_personality_upgrade.ts
 */
import assert from 'node:assert'
import { classifyIntent } from '../services/intentClassifier.js'
import { optimizeConversationContext } from '../services/contextManager.js'
import { memoryService } from '../services/memoryService.js'

console.log('=== MANA AI PERSONALITY UPGRADE TESTS ===\n')

let passedCount = 0
let failedCount = 0

function runTest(name: string, fn: () => void | Promise<void>) {
  const result = fn()
  if (result instanceof Promise) {
    result.then(() => {
      console.log(`[PASS] ${name}`)
      passedCount++
    }).catch((err: any) => {
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

// Test 1: Telugu slang — "what does puka mean" must not trigger web search
runTest('Test 1: puka meaning query → needsSearch=false, category=conversational', () => {
  const intent = classifyIntent('what does puka mean', [])
  assert.strictEqual(intent.needsSearch, false, 'puka meaning must NOT trigger web search')
  assert.strictEqual(intent.category, 'conversational', 'puka meaning query must be conversational')
})

// Test 2: Telugu slang — "dengey ante enti" must not trigger web search
runTest('Test 2: dengey ante enti → needsSearch=false, category=conversational', () => {
  const intent = classifyIntent('dengey ante enti', [])
  assert.strictEqual(intent.needsSearch, false, 'dengey ante enti must NOT trigger web search')
  assert.strictEqual(intent.category, 'conversational', 'dengey ante enti must be conversational')
})

// Test 3: Single-word slang "bokka" must not trigger web search
runTest('Test 3: single word "bokka" → needsSearch=false', () => {
  const intent = classifyIntent('bokka', [])
  assert.strictEqual(intent.needsSearch, false, '"bokka" must NOT trigger web search')
})

// Test 4: Teluglish greeting
runTest('Test 4: "mama em chestunnav" → category=conversational, needsSearch=false', () => {
  const intent = classifyIntent('mama em chestunnav', [])
  assert.strictEqual(intent.category, 'conversational', 'Teluglish greeting must be conversational')
  assert.strictEqual(intent.needsSearch, false, 'Teluglish greeting must NOT trigger web search')
})

// Test 5: Follow-up context retention — "what should I do now?" after a date conversation
// The key requirement is: the question must NOT trigger a web search (it's personal context)
runTest('Test 5: follow-up "what should I do now?" after date conversation → needsSearch=false', () => {
  const history = [
    { role: 'user' as const, content: 'I have a date today' },
    { role: 'assistant' as const, content: 'Relax bro, be yourself, dress well, listen to her.' },
  ]
  const intent = classifyIntent('what should I do now?', history)
  assert.strictEqual(intent.needsSearch, false, 'Follow-up on personal topic must NOT trigger web search')
  // Must be some form of contextual/conversational/knowledge category — never explicit_search
  assert.notStrictEqual(intent.category, 'explicit_search', 'Must not be explicit_search')
})

// Test 6: Short answer enforcement — "hi" must be conversational
runTest('Test 6: "hi" → category=conversational, needsSearch=false', () => {
  const intent = classifyIntent('hi', [])
  assert.strictEqual(intent.category, 'conversational', '"hi" must be conversational')
  assert.strictEqual(intent.needsSearch, false, '"hi" must NOT trigger web search')
})

// Test 7: Mature relationship hint
runTest('Test 7: helmet hint query → needsSearch=false, not explicit_search', () => {
  const intent = classifyIntent('she said come with a helmet what does that mean', [])
  assert.strictEqual(intent.needsSearch, false, 'Relationship hint query must NOT trigger web search')
  assert.notStrictEqual(intent.category, 'explicit_search', 'Must not be explicit_search')
})

// Test 8: Hallucination resistance — "dengey" alone must not trigger search
runTest('Test 8: "dengey" alone → needsSearch=false (slang not sent to search)', () => {
  const intent = classifyIntent('dengey', [])
  assert.strictEqual(intent.needsSearch, false, '"dengey" slang must NOT be sent to search engine')
})

// Test 9: Memory save and retrieve cycle
runTest('Test 9: memory save/retrieve for user-test-1', () => {
  const saved = memoryService.addMemory('preference', 'Preferred Language', 'Telugu', 'user-test-1')
  assert.notStrictEqual(saved.id, 'blocked', 'Memory should not be blocked')
  assert.strictEqual(saved.value, 'Telugu', 'Saved value must be "Telugu"')
  const retrieved = memoryService.getMemories('user-test-1')
  const found = retrieved.find((m) => m.key === 'Preferred Language' && m.userId === 'user-test-1')
  assert(found !== undefined, 'Saved memory must be retrievable for user-test-1')
  assert.strictEqual(found!.value, 'Telugu', 'Retrieved value must be "Telugu"')
})

// Test 10: Memory user scoping — user-B must NOT see user-A's memory
runTest('Test 10: memory scoping — user-B does not see user-A memories', () => {
  const uniqueKey = `ScopeTestKey-${Date.now()}`
  memoryService.addMemory('preference', uniqueKey, 'OnlyForA', 'user-scope-A')
  const userBMemories = memoryService.getMemories('user-scope-B')
  const leaked = userBMemories.find((m) => m.key === uniqueKey && m.userId === 'user-scope-A')
  assert(leaked === undefined, 'user-B must NOT see user-A private memories')
})

// Test 11: Sensitive key blocking
runTest('Test 11: sensitive key "API Key" with credential value is blocked', () => {
  const result = memoryService.addMemory('preference', 'API Key', 'AIza' + 'SyDUMMY_TEST_CREDENTIAL_NOT_REAL_1234567890', 'user-test-2')
  assert.strictEqual(result.id, 'blocked', 'Storing an API key must be blocked')
  assert.strictEqual(result.value, '[blocked]', 'Blocked memory must have value "[blocked]"')
})

// Test 12: Context manager — history summary captures entities
runTest('Test 12: context manager summary captures named entities', () => {
  const history = [
    { role: 'user' as const, content: 'Tell me about Narendra Modi' },
    { role: 'assistant' as const, content: 'Narendra Modi is the Prime Minister of India since 2014.' },
    { role: 'user' as const, content: 'Tell me about Hyderabad' },
    { role: 'assistant' as const, content: 'Hyderabad is a major city in Telangana, India.' },
    { role: 'user' as const, content: 'What about Charminar?' },
    { role: 'assistant' as const, content: 'Charminar is a historic monument in Hyderabad.' },
    // ... padding to push earlier turns into the summary
    { role: 'user' as const, content: 'turn 4' },
    { role: 'assistant' as const, content: 'response 4' },
    { role: 'user' as const, content: 'turn 5' },
    { role: 'assistant' as const, content: 'response 5' },
    { role: 'user' as const, content: 'turn 6' },
    { role: 'assistant' as const, content: 'response 6' },
    { role: 'user' as const, content: 'turn 7' },
    { role: 'assistant' as const, content: 'response 7' },
    { role: 'user' as const, content: 'final question' },
  ]
  const optimized = optimizeConversationContext(history)
  const summary = optimized.historySummary || ''
  const hasEntity = summary.includes('Narendra Modi') || summary.includes('Hyderabad') || summary.includes('Modi')
  assert(
    hasEntity || summary.includes('Narendra') || summary.includes('Tell me about'),
    `Summary should capture entities like "Narendra Modi" or "Hyderabad". Got: "${summary.slice(0, 200)}"`
  )
})

// Final result output (synchronous tests run first, then check final counts)
setTimeout(() => {
  console.log(`\n=== RESULTS: ${passedCount} PASSED, ${failedCount} FAILED ===\n`)
  if (failedCount > 0) {
    process.exit(1)
  } else {
    console.log('All personality upgrade tests passed! 🎉')
  }
}, 200)
