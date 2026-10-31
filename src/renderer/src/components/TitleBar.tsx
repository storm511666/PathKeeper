import type { ReactNode } from 'react'
import type { Project } from '@shared/types'
import { BrandMark } from './ui'

/**
 * The 38px custom titlebar: a drag strip that also carries the product and
 * current-project state. The Windows caption buttons overlay the top-right,
 * so nothing interactive lives here (the right inset keeps text clear of them).
 */
export function TitleBar({ project }: { project: Project | null }): ReactNode {
  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        <span className="titlebar-brand">
          <BrandMark size={15} />
          <span className="titlebar-word">PATHKEEPER</span>
        </span>
        <span className="titlebar-rule" aria-hidden="true" />
        <span className="titlebar-context" title={project?.rootPath ?? undefined}>
          {project ? project.name : '未选择项目'}
        </span>
      </div>
      <div className="titlebar-state">
        <span className="titlebar-dot" aria-hidden="true" />
        <span>本地存储 · 无网络</span>
      </div>
    </header>
  )
}
