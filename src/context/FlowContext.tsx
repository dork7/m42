import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  initialAnswers,
  type AnalysisResult,
  type FlowDirection,
  type FlowStep,
  type QuizAnswers,
} from '../types/flow'

type FlowContextValue = {
  step: FlowStep
  direction: FlowDirection
  photo: string | null
  answers: QuizAnswers
  result: AnalysisResult | null
  quizIndex: number
  setPhoto: (photo: string | null) => void
  setAnswer: <K extends keyof QuizAnswers>(key: K, value: QuizAnswers[K]) => void
  setResult: (result: AnalysisResult | null) => void
  goToStep: (step: FlowStep, direction?: FlowDirection) => void
  nextStep: () => void
  prevStep: () => void
  setQuizIndex: (index: number) => void
  resetForRetake: () => void
}

const FlowContext = createContext<FlowContextValue | null>(null)

export function FlowProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<FlowStep>(1)
  const [direction, setDirection] = useState<FlowDirection>('forward')
  const [photo, setPhoto] = useState<string | null>(null)
  const [answers, setAnswers] = useState<QuizAnswers>(initialAnswers)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [quizIndex, setQuizIndex] = useState(0)

  const goToStep = useCallback((next: FlowStep, dir: FlowDirection = 'forward') => {
    setDirection(dir)
    setStep(next)
  }, [])

  const nextStep = useCallback(() => {
    setDirection('forward')
    setStep((s) => Math.min(5, s + 1) as FlowStep)
  }, [])

  const prevStep = useCallback(() => {
    setDirection('back')
    setStep((s) => Math.max(1, s - 1) as FlowStep)
  }, [])

  const setAnswer = useCallback(
    <K extends keyof QuizAnswers>(key: K, value: QuizAnswers[K]) => {
      setAnswers((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  const resetForRetake = useCallback(() => {
    setPhoto(null)
    setResult(null)
    setDirection('back')
    setStep(2)
  }, [])

  const value = useMemo(
    () => ({
      step,
      direction,
      photo,
      answers,
      result,
      quizIndex,
      setPhoto,
      setAnswer,
      setResult,
      goToStep,
      nextStep,
      prevStep,
      setQuizIndex,
      resetForRetake,
    }),
    [
      step,
      direction,
      photo,
      answers,
      result,
      quizIndex,
      goToStep,
      nextStep,
      prevStep,
      resetForRetake,
    ],
  )

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>
}

export function useFlow() {
  const ctx = useContext(FlowContext)
  if (!ctx) throw new Error('useFlow must be used within FlowProvider')
  return ctx
}
