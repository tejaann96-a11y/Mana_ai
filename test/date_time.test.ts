import {
  answerLocalDateTimeQuestion,
  buildLocalDateTimeContext,
  getLocalDateTimeSnapshot,
} from '../server/services/dateTimeService.js'

let failures = 0

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`)
  } else {
    console.error(`  ❌ ${label}: expected ${String(expected)}, got ${String(actual)}`)
    failures++
  }
}

console.log('\n[Local date/time] Asia/Kolkata midnight boundary')
{
  const beforeMidnight = getLocalDateTimeSnapshot(new Date('2026-10-31T18:29:00.000Z'))
  const afterMidnight = getLocalDateTimeSnapshot(new Date('2026-10-31T18:35:00.000Z'))
  assertEqual(beforeMidnight.localDate, '2026-10-31', 'UTC conversion retains prior Kolkata date')
  assertEqual(afterMidnight.localDate, '2026-11-01', 'UTC conversion crosses Kolkata midnight')
  assertEqual(afterMidnight.time, '12:05 am', 'time is formatted in Kolkata local time')
  assertEqual(afterMidnight.dayOfWeek, 'Sunday', 'weekday follows local calendar date')
}

console.log('\n[Local date/time] tomorrow/yesterday and DST-independent timezone')
{
  const snapshot = getLocalDateTimeSnapshot(new Date('2026-10-31T18:35:00.000Z'))
  assertEqual(snapshot.tomorrow, 'Monday, 2 November 2026', 'tomorrow uses calendar arithmetic')
  assertEqual(snapshot.yesterday, 'Saturday, 31 October 2026', 'yesterday uses calendar arithmetic')
}

console.log('\n[Local date/time] direct answers and context injection')
{
  const now = new Date('2026-10-31T18:35:00.000Z')
  assertEqual(
    answerLocalDateTimeQuestion("What's today's date?", now),
    'Today is Sunday, 1 November 2026.',
    'today question is answered deterministically'
  )
  assertEqual(
    answerLocalDateTimeQuestion('What time is it now?', now),
    'The current time is 12:05 am (Asia/Kolkata).',
    'time question is answered deterministically'
  )
  assertEqual(
    answerLocalDateTimeQuestion('What date is tomorrow?', now),
    'Tomorrow is Monday, 2 November 2026.',
    'tomorrow question is answered deterministically'
  )
  assertEqual(answerLocalDateTimeQuestion('Explain time complexity.', now), null, 'unrelated time concept is not intercepted')
  assertEqual(
    buildLocalDateTimeContext(now).includes('Timezone: Asia/Kolkata'),
    true,
    'current date context records default timezone'
  )
}

if (failures > 0) {
  console.error(`\n${failures} date/time assertion(s) failed.`)
  process.exitCode = 1
} else {
  console.log('\nAll date/time assertions passed.')
}
