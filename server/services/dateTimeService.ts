export const DEFAULT_TIME_ZONE = 'Asia/Kolkata'

export interface LocalDateTimeSnapshot {
  timezone: string
  localDate: string
  date: string
  dayOfWeek: string
  time: string
  tomorrow: string
  yesterday: string
}

function getDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone,
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  }
}

function formatCalendarDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(date)
}

function formatDateOffset(date: Date, timeZone: string, offsetDays: number): string {
  const { year, month, day } = getDateParts(date, timeZone)
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays, 12))
  return formatCalendarDate(shifted, timeZone)
}

export function getLocalDateTimeSnapshot(
  now: Date = new Date(),
  timeZone = DEFAULT_TIME_ZONE
): LocalDateTimeSnapshot {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('A valid date is required to format local date and time.')
  }

  const parts = getDateParts(now, timeZone)
  const localDate = [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-')

  return {
    timezone: timeZone,
    localDate,
    date: formatCalendarDate(now, timeZone),
    dayOfWeek: new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone,
    }).format(now),
    time: new Intl.DateTimeFormat('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone,
    }).format(now),
    tomorrow: formatDateOffset(now, timeZone, 1),
    yesterday: formatDateOffset(now, timeZone, -1),
  }
}

export function buildLocalDateTimeContext(now: Date = new Date()): string {
  const current = getLocalDateTimeSnapshot(now)
  return [
    'CURRENT LOCAL DATE AND TIME (authoritative; do not guess):',
    `Timezone: ${current.timezone}`,
    `Current date: ${current.date} (${current.localDate})`,
    `Current time: ${current.time}`,
    `Day of week: ${current.dayOfWeek}`,
    `Tomorrow: ${current.tomorrow}`,
    `Yesterday: ${current.yesterday}`,
    'Use these values for date-dependent answers. If the user asks for the date or time directly, answer from application data rather than estimating.',
  ].join('\n')
}

export function answerLocalDateTimeQuestion(
  prompt: string,
  now: Date = new Date()
): string | null {
  const cleanPrompt = prompt.trim().replace(/[?!.,]+$/g, '').trim()
  if (!cleanPrompt || cleanPrompt.length > 160) return null

  const lower = cleanPrompt.toLowerCase().replace(/['’]/g, '')
  const asksTime = /\b(time|clock)\b/.test(lower)
  const asksDate = /\b(date|day|weekday)\b/.test(lower)
  const asksCurrent = /\b(today|tomorrow|yesterday|now|current|right now)\b/.test(lower)
  const directQuestion = /^(what|whats|what is|what was|what will|which|tell me|give me|show me)\b/.test(lower)

  if ((!asksTime && !asksDate) || (!asksCurrent && !directQuestion)) return null

  const current = getLocalDateTimeSnapshot(now)
  const asksTomorrow = /\btomorrow\b/.test(lower)
  const asksYesterday = /\byesterday\b/.test(lower)
  const selectedDate = asksTomorrow
    ? current.tomorrow
    : asksYesterday
      ? current.yesterday
      : current.date
  const selectedDay = asksTomorrow
    ? selectedDate.split(',')[0]
    : asksYesterday
      ? selectedDate.split(',')[0]
      : current.dayOfWeek

  if (asksTime && asksDate) {
    return `It is ${current.time} on ${current.date} (${current.timezone}).`
  }
  if (asksTime) {
    return `The current time is ${current.time} (${current.timezone}).`
  }
  if (/\b(weekday|day of week|what day)\b/.test(lower)) {
    return `It is ${selectedDay}${asksTomorrow ? ' tomorrow' : asksYesterday ? ' yesterday' : ' today'}.`
  }
  if (asksTomorrow) return `Tomorrow is ${selectedDate}.`
  if (asksYesterday) return `Yesterday was ${selectedDate}.`
  return `Today is ${current.date}.`
}
