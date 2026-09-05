import type { AnalysisResult, Cause, QuizAnswers, Severity } from '../types/flow'

const ANALYZE_SKIN_URL = '/api/analyze-skin'

type N8nSeverity = 'mild' | 'moderate' | 'noticeable'

type N8nConcern = {
  title: string
  description: string
  severity: N8nSeverity
}

type N8nCause = {
  icon: string
  title: string
  description: string
}

type N8nSkinAnalysis = {
  skinScore: number
  skinType?: string
  concerns: N8nConcern[]
  causes?: N8nCause[]
}

const severityMap: Record<N8nSeverity, Severity> = {
  mild: 'Mild',
  moderate: 'Moderate',
  noticeable: 'Noticeable',
}

function unwrapN8nPayload(data: unknown): N8nSkinAnalysis {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      throw new Error('Analysis returned no results. Try again in a moment.')
    }
    return data[0] as N8nSkinAnalysis
  }
  return data as N8nSkinAnalysis
}

function mapN8nResponse(data: N8nSkinAnalysis): AnalysisResult {
  return {
    score: data.skinScore,
    skinType: data.skinType ?? 'Unknown',
    concerns: (data.concerns ?? []).map((c) => ({
      name: c.title,
      severity: severityMap[c.severity] ?? 'Mild',
      description: c.description,
    })),
    causes: (data.causes ?? []).map(
      (c): Cause => ({
        icon: c.icon,
        title: c.title,
        description: c.description,
      }),
    ),
  }
}

export async function analyzeSkin(
  photo: string,
  answers: QuizAnswers,
): Promise<AnalysisResult> {
  const response = await fetch(ANALYZE_SKIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: photo, answers }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || 'Analysis failed. Try again in a moment.')
  }

  const data = unwrapN8nPayload(await response.json())
  return mapN8nResponse(data)
}
