import { AnimatePresence, motion } from 'framer-motion'
import { useFlow } from '../context/FlowContext'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { AmbientBackground } from './AmbientBackground'
import { ProgressStepper } from './ProgressStepper'
import { AnalyzingScreen } from './screens/AnalyzingScreen'
import { IntroScreen } from './screens/IntroScreen'
import { PhotoScreen } from './screens/PhotoScreen'
import { QuizScreen } from './screens/QuizScreen'
import { ResultsScreen } from './screens/ResultsScreen'

const screens = {
  1: IntroScreen,
  2: PhotoScreen,
  3: QuizScreen,
  4: AnalyzingScreen,
  5: ResultsScreen,
} as const

export function Flow() {
  const { step, direction } = useFlow()
  const reducedMotion = useReducedMotion()
  const Screen = screens[step]

  const slideOffset = reducedMotion ? 0 : 12
  const variants = {
    enter: (dir: 'forward' | 'back') => ({
      opacity: 0,
      x: dir === 'forward' ? slideOffset : -slideOffset,
    }),
    center: { opacity: 1, x: 0 },
    exit: (dir: 'forward' | 'back') => ({
      opacity: 0,
      x: dir === 'forward' ? -slideOffset : slideOffset,
    }),
  }

  return (
    <div className="relative min-h-dvh">
      <AmbientBackground />
      {step >= 2 && <ProgressStepper currentStep={step} />}
      <main className="relative z-10 flex min-h-dvh items-center justify-center px-5 py-16">
        <div className="w-full max-w-flow md:max-w-flow-md">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.35, ease: 'easeOut' }}
            >
              <Screen />
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  )
}
