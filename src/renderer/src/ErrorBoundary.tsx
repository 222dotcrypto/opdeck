import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  info: ErrorInfo | null
}

// Ловушка ошибок рендера: показывает точное сообщение и какой компонент упал.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, info })
    console.error('Render error:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error, info } = this.state
    if (error) {
      return (
        <pre
          style={{
            color: '#f85149',
            background: '#16161a',
            padding: 20,
            whiteSpace: 'pre-wrap',
            font: '12px monospace',
            height: '100vh',
            margin: 0,
            overflow: 'auto'
          }}
        >
          {'Ошибка рендера:\n\n'}
          {String(error.name)}: {String(error.message)}
          {'\n\n— Где (стек компонентов): —'}
          {String(info?.componentStack ?? '')}
          {'\n\n— Технический стек: —\n'}
          {String(error.stack ?? '')}
        </pre>
      )
    }
    return this.props.children
  }
}
