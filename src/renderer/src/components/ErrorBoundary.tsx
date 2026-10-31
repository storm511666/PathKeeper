import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RouteMotif } from './ui'
import { humanizeError } from '@renderer/lib/errors'

interface ErrorBoundaryState {
  error: Error | null
}

/** Last line of defence: never show a blank window if a page crashes. */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[PathKeeper] renderer error', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const human = humanizeError(error)
    return (
      <div className="boot-failure-screen" role="alert">
        <div className="boot-failure-card">
          <RouteMotif variant="route" />
          <h1>{human.title}</h1>
          <p>{human.message} 项目文件没有被写入。</p>
          <ol className="boot-failure-steps">
            {human.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {human.technical ? (
            <details className="boot-failure-technical">
              <summary>技术细节</summary>
              <pre className="boot-failure-message">{human.technical}</pre>
            </details>
          ) : null}
          <button type="button" className="btn btn-primary btn-md" onClick={() => window.location.reload()}>
            重新加载界面
          </button>
        </div>
      </div>
    )
  }
}
