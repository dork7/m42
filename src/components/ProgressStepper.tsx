import type { FlowStep } from '../types/flow'

type Props = {
  currentStep: FlowStep
}

export function ProgressStepper({ currentStep }: Props) {
  const steps = [1, 2, 3, 4, 5] as const

  return (
    <div
      className="fixed left-1/2 top-6 z-20 flex -translate-x-1/2 items-center gap-2"
      aria-label={`Step ${currentStep} of 5`}
    >
      {steps.map((step, i) => {
        const isCompleted = step < currentStep
        const isCurrent = step === currentStep

        return (
          <div key={step} className="flex items-center gap-2">
            <div
              className={`h-2 w-2 rounded-full transition-colors ${
                isCurrent || isCompleted ? 'bg-berry' : 'bg-berry/25'
              }`}
              aria-current={isCurrent ? 'step' : undefined}
            />
            {i < steps.length - 1 && (
              <div
                className={`h-px w-4 transition-colors ${
                  isCompleted ? 'bg-berry' : 'bg-berry/20'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
