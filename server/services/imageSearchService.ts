import { ImageSearchEvidence, ImageSearchResult, SearchProvider } from '../types.js'

const MAX_IMAGE_RESULTS = 8
const IMAGE_SEARCH_TIMEOUT_MS = 10000
const cache = new Map<string, { timestamp: number; evidence: ImageSearchEvidence }>()
const CACHE_TTL_MS = 5 * 60 * 1000

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(IMAGE_SEARCH_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason || new DOMException('The operation was aborted.', 'AbortError')
  }
}

function parsePublicUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname === '::1' ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) return null
    return url
  } catch {
    return null
  }
}

function toImageResult(
  id: string,
  imageValue: unknown,
  thumbnailValue: unknown,
  sourceValue: unknown,
  titleValue: unknown,
  licenseValue?: unknown,
): ImageSearchResult | null {
  const imageUrl = parsePublicUrl(imageValue)
  const thumbnailUrl = parsePublicUrl(thumbnailValue) || imageUrl
  const sourceUrl = parsePublicUrl(sourceValue) || imageUrl
  if (!imageUrl || !thumbnailUrl || !sourceUrl) return null

  const sourceDomain = sourceUrl.hostname.replace(/^www\./, '')
  const title = typeof titleValue === 'string' ? titleValue.replace(/\s+/g, ' ').trim().slice(0, 180) : ''
  const license = typeof licenseValue === 'string' ? licenseValue.trim().slice(0, 100) : ''
  return {
    id,
    title: title || `Image from ${sourceDomain}`,
    imageUrl: imageUrl.href,
    thumbnailUrl: thumbnailUrl.href,
    sourceUrl: sourceUrl.href,
    sourceDomain,
    ...(license ? { license } : {}),
  }
}

function uniqueResults(results: Array<ImageSearchResult | null>): ImageSearchResult[] {
  const seen = new Set<string>()
  return results.filter((result): result is ImageSearchResult => {
    if (!result || seen.has(result.imageUrl)) return false
    seen.add(result.imageUrl)
    return true
  }).slice(0, MAX_IMAGE_RESULTS)
}

async function searchDuckDuckGoImages(query: string, signal?: AbortSignal): Promise<ImageSearchResult[]> {
  const landingUrl = new URL('https://duckduckgo.com/')
  landingUrl.search = new URLSearchParams({ q: query, iax: 'images', ia: 'images' }).toString()
  const landingResponse = await fetch(landingUrl, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    },
    signal: requestSignal(signal),
  })
  if (!landingResponse.ok) throw new Error(`DuckDuckGo image search returned HTTP ${landingResponse.status}.`)
  const html = await landingResponse.text()
  const token = html.match(/\bvqd\s*=\s*["']([^"']+)["']/i)?.[1]
    || html.match(/"vqd"\s*:\s*"([^"]+)"/i)?.[1]
  if (!token) throw new Error('DuckDuckGo did not provide an image-search token.')

  const imageUrl = new URL('https://duckduckgo.com/i.js')
  imageUrl.search = new URLSearchParams({
    l: 'us-en',
    o: 'json',
    q: query,
    vqd: token,
    f: ',,,',
    p: '1',
  }).toString()
  const response = await fetch(imageUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      Referer: landingUrl.href,
    },
    signal: requestSignal(signal),
  })
  if (!response.ok) throw new Error(`DuckDuckGo image results returned HTTP ${response.status}.`)
  const data = await response.json() as { results?: Array<Record<string, unknown>> }
  return uniqueResults((data.results || []).map((item, index) =>
    toImageResult(
      `ddg-image-${index + 1}`,
      item.image,
      item.thumbnail,
      item.url,
      item.title || item.source,
      item.license,
    )
  ))
}

async function searchSerperImages(query: string, apiKey: string, signal?: AbortSignal): Promise<ImageSearchResult[]> {
  const response = await fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: MAX_IMAGE_RESULTS }),
    signal: requestSignal(signal),
  })
  if (!response.ok) throw new Error(`Serper image search returned HTTP ${response.status}.`)
  const data = await response.json() as { images?: Array<Record<string, unknown>> }
  return uniqueResults((data.images || []).map((item, index) =>
    toImageResult(
      `serper-image-${index + 1}`,
      item.imageUrl,
      item.thumbnailUrl,
      item.link,
      item.title || item.source,
      item.license,
    )
  ))
}

async function searchBraveImages(query: string, apiKey: string, signal?: AbortSignal): Promise<ImageSearchResult[]> {
  const endpoint = new URL('https://api.search.brave.com/res/v1/images/search')
  endpoint.search = new URLSearchParams({ q: query, count: String(MAX_IMAGE_RESULTS) }).toString()
  const response = await fetch(endpoint, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
    signal: requestSignal(signal),
  })
  if (!response.ok) throw new Error(`Brave image search returned HTTP ${response.status}.`)
  const data = await response.json() as { results?: Array<Record<string, unknown>> }
  return uniqueResults((data.results || []).map((item, index) => {
    const properties = item.properties as Record<string, unknown> | undefined
    const thumbnail = item.thumbnail as Record<string, unknown> | undefined
    return toImageResult(
      `brave-image-${index + 1}`,
      properties?.url || item.image,
      thumbnail?.src || item.thumbnail,
      item.url,
      item.title || item.source,
      item.license,
    )
  }))
}

async function searchTavilyImages(query: string, apiKey: string, signal?: AbortSignal): Promise<ImageSearchResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      include_images: true,
      include_image_descriptions: true,
      max_results: MAX_IMAGE_RESULTS,
    }),
    signal: requestSignal(signal),
  })
  if (!response.ok) throw new Error(`Tavily image search returned HTTP ${response.status}.`)
  const data = await response.json() as { images?: Array<string | Record<string, unknown>> }
  return uniqueResults((data.images || []).map((image, index) => {
    const item = typeof image === 'string' ? { url: image } : image
    const url = item.url
    return toImageResult(`tavily-image-${index + 1}`, url, url, url, item.description || item.title, item.license)
  }))
}

export async function executeImageSearch(
  query: string,
  provider: SearchProvider,
  apiKeys: { tavily?: string; serper?: string; brave?: string },
  signal?: AbortSignal,
): Promise<ImageSearchEvidence> {
  throwIfAborted(signal)
  const normalizedQuery = query.toLowerCase().trim()
  const cacheKey = `${provider}:${normalizedQuery}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ...cached.evidence, searchedAt: new Date().toISOString() }
  }

  const startedAt = Date.now()
  const configuredKey = provider === 'tavily' ? apiKeys.tavily : provider === 'serper' ? apiKeys.serper : provider === 'brave' ? apiKeys.brave : undefined
  let actualProvider: SearchProvider = configuredKey ? provider : 'duckduckgo'
  let results: ImageSearchResult[] = []
  let errorMessage: string | undefined
  try {
    if (actualProvider === 'tavily') {
      results = await searchTavilyImages(query, apiKeys.tavily!, signal)
    } else if (actualProvider === 'serper') {
      results = await searchSerperImages(query, apiKeys.serper!, signal)
    } else if (actualProvider === 'brave') {
      results = await searchBraveImages(query, apiKeys.brave!, signal)
    } else {
      results = await searchDuckDuckGoImages(query, signal)
    }
  } catch (error) {
    throwIfAborted(signal)
    const reason = error instanceof Error ? error.message : 'Image search failed.'
    console.warn(`[ImageSearchService] ${actualProvider} image search failed: ${reason}`)
    if (actualProvider !== 'duckduckgo') {
      try {
        actualProvider = 'duckduckgo'
        results = await searchDuckDuckGoImages(query, signal)
      } catch (fallbackError) {
        throwIfAborted(signal)
        const fallbackReason = fallbackError instanceof Error ? fallbackError.message : 'Image search fallback failed.'
        errorMessage = `Image search is unavailable from ${provider} and DuckDuckGo (${fallbackReason}).`
      }
    } else {
      errorMessage = `Image search is unavailable from DuckDuckGo (${reason}).`
    }
  }

  const evidence: ImageSearchEvidence = {
    query,
    provider: actualProvider,
    results,
    searchedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    ...(results.length === 0 && !errorMessage ? { errorMessage: 'No usable image results were returned.' } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  }
  if (results.length) cache.set(cacheKey, { timestamp: Date.now(), evidence })
  return evidence
}

export function extractImageSearchQuery(prompt: string): string | null {
  const text = prompt.trim()
  if (!text || /\b(generate|create|draw|paint|render|illustrate|synthesize|make me an ai image)\b/i.test(text)) return null

  const imageIntent =
    /\b(show|find|search for|look for|display|get|give me|send me)\b[\s\S]{0,80}\b(photographs?|photos?|pictures?|images?|pics?|wallpapers?|visual references?|reference images?)\b/i.test(text) ||
    /\b(photographs?|photos?|pictures?|images?|pics?|wallpapers?|visual references?|reference images?)\s+(of|for|from)\b/i.test(text) ||
    /\b(do you have|can i see|could i see)\b[\s\S]{0,80}\b(photographs?|photos?|pictures?|images?|pics?)\b/i.test(text) ||
    /\bimage search(?:\s+for)?\b/i.test(text) ||
    /\bwhat does .{2,100} look like\b/i.test(text)
  if (!imageIntent) return null

  return text
    .replace(/^\s*(please\s+)?(?:(?:can|could|would)\s+you\s+)?(show|find|search for|look for|display|get|give|send)(?:\s+me|\s+us)?\s+(some\s+)?/i, '')
    .replace(/^\s*(do you have|can i see|could i see)\s+/i, '')
    .replace(/\b(real|actual|internet|existing|reference)\s+/gi, '')
    .replace(/\bimage search(?:\s+for)?\s+/gi, '')
    .replace(/\b(photographs?|photos?|pictures?|images?|pics?|wallpapers?|visual references?|reference images?)\s+(of|for|from)\s+/gi, '')
    .replace(/\b(photographs?|photos?|pictures?|images?|pics?|wallpapers?|visual references?|reference images?)\b/gi, '')
    .replace(/\b(please|thanks|thank you)\b/gi, '')
    .replace(/^(?:a|an|some)\s+/i, '')
    .replace(/^[\s:,-]+|[\s?!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim() || text
}
