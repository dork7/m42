import { FlowProvider } from './context/FlowContext'
import { Flow } from './components/Flow'

function App() {
  return (
    <FlowProvider>
      <Flow />
    </FlowProvider>
  )
}

export default App
