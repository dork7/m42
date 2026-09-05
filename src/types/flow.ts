export type FlowStep = 1 | 2 | 3 | 4 | 5

export type Severity = 'Mild' | 'Moderate' | 'Noticeable'

export type Concern = {
  name: string
  severity: Severity
  description: string
}

export type Cause = {
  icon: string
  title: string
  description: string
}

export type AnalysisResult = {
  score: number
  skinType: string
  concerns: Concern[]
  causes: Cause[]
}

export type QuizAnswers = {
  mainConcern: string | null
  skinType: string | null
  sunscreen: string | null
  routine: string | null
}

export type FlowDirection = 'forward' | 'back'

export const initialAnswers: QuizAnswers = {
  mainConcern: null,
  skinType: null,
  sunscreen: null,
  routine: null,
}

export type QuizQuestion = {
  id: keyof QuizAnswers
  question: string
  options: string[]
  multiSelect?: boolean
  maxSelect?: number
}

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 'mainConcern',
    question: "What's your main skin concern right now?",
    options: [
      'Acne & Breakouts',
      'Fine Lines & Wrinkles',
      'Dark Spots & Uneven Tone',
      'Dullness & Texture',
    ],
  },
  {
    id: 'skinType',
    question: 'How would you describe your skin type?',
    options: ['Oily', 'Dry', 'Combination', 'Sensitive'],
  },
  {
    id: 'sunscreen',
    question: 'How often do you wear sunscreen?',
    options: ['Daily', 'Sometimes', 'Rarely', 'Never'],
  },
  {
    id: 'routine',
    question: 'How would you describe your current skincare routine?',
    options: [
      "None — I don't use any products",
      'Basic — cleanser and moisturizer only',
      'Moderate — includes serums or treatments',
      'Extensive — full multi-step routine',
    ],
  },
]
