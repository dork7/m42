// Local dev helper: POST the captured photo to the local vision service for an
// ad-hoc "AI CHECK". Routed through the Vite `/vision-api` proxy (see
// vite.config.ts), which adds the Cookie header and avoids CORS.

const VISION_URL = '/vision-api/analyze'
const DEFAULT_PROMPT =
  'Analyze this image, check if the image of the person is centered'
const VISION_MODEL = 'ornith-1.0-9b-q4'

export type VisionCheckResult = {
  /** Best-effort human-readable text pulled from the response. */
  text: string
  /** The full parsed response (JSON when possible, otherwise the raw string). */
  raw: unknown
}

/** True when the app is served from localhost (dev) — the proxy only exists there. */
export function isLocalHost(): boolean {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return res.blob()
}

const TEXT_KEYS = [
  'details',
  'rawText',
  'result',
  'text',
  'analysis',
  'output',
  'response',
  'description',
  'content',
  'message',
]

function pickText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    // This service wraps payloads as { success, message, responseObject }.
    if ('responseObject' in o && o.responseObject != null) {
      const inner = pickText(o.responseObject)
      if (inner.trim()) return inner
    }
    for (const key of TEXT_KEYS) {
      const v = o[key]
      if (typeof v === 'string' && v.trim()) return v
    }
  }
  return JSON.stringify(raw, null, 2)
}

export async function analyzeImageWithAI(
  photoDataUrl: string,
  prompt: string = DEFAULT_PROMPT,
): Promise<VisionCheckResult> {
  const blob = await dataUrlToBlob(photoDataUrl)
  const form = new FormData()
  form.append('image', blob, 'capture.jpg')
  form.append('prompt', prompt)
  form.append('model', VISION_MODEL)

  // The local model can be slow (cold start / large model), so give it room
  // but don't let the UI hang forever.
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 240_000)
  let response: Response
  try {
    response = await fetch(VISION_URL, {
      method: 'POST',
      body: form,
      signal: abort.signal,
    })
  } catch (err) {
    if (abort.signal.aborted) {
      throw new Error('AI check timed out (the model took over 4 minutes).')
    }
    throw err instanceof Error ? err : new Error('AI check request failed.')
  } finally {
    clearTimeout(timer)
  }

  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(
      `AI check failed (${response.status}). ${bodyText.slice(0, 300)}`.trim(),
    )
  }

  let raw: unknown = bodyText
  try {
    raw = JSON.parse(bodyText)
  } catch {
    /* keep raw string */
  }
  return { text: pickText(raw), raw }
}
