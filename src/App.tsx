import { lazy, Suspense } from 'react'
import { FlowProvider } from './context/FlowContext'
// import { Flow } from './components/Flow' // ← restore together with <Flow /> below

// The ported standalone face-capture flow. Its own route is /face-app; it is
// also shown on the root route for now (see the commented <Flow /> below).
const FaceApp = lazy(() => import('./face-app/FaceApp'))

function App() {
  if (window.location.pathname.replace(/\/+$/, '') === '/face-app') {
    return (
      <Suspense fallback={null}>
        <FaceApp />
      </Suspense>
    )
  }

  return (
    <FlowProvider>
      <Suspense fallback={null}>
        <FaceApp />
      </Suspense>
      {/* <Flow /> */}
    </FlowProvider>
  )
}

export default App
