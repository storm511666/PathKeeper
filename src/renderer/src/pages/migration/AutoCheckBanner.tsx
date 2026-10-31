import type { ReactNode } from 'react'
import { ScanSearch, Sparkles } from 'lucide-react'
import { Button } from '@renderer/components/ui'

export interface AutoCheckBannerProps {
  loading: boolean
  disabled?: boolean
  onCheck: () => void
}

/**
 * Beginner-friendly entry point: do not make the user invent an old/new path.
 * The text also makes the mental model obvious: first move the file, then check.
 */
export function AutoCheckBanner({ loading, disabled = false, onCheck }: AutoCheckBannerProps): ReactNode {
  return (
    <section className="auto-check-banner" data-testid="auto-check-banner" aria-label="自动检查断开的路径">
      <span className="auto-check-banner-icon" aria-hidden="true">
        <ScanSearch size={24} />
      </span>
      <div className="auto-check-banner-copy">
        <p className="auto-check-kicker mono">
          <Sparkles size={11} aria-hidden="true" /> 新手模式 · 不用懂旧路径/新路径
        </p>
        <h2>先让软件自动检查：哪些引用已经找不到文件了？</h2>
        <p>
          先像平时一样，在资源管理器里把文件移动或改名。然后点右侧按钮，PathKeeper
          会找出所有“指向已不存在文件”的路径，并列出它可能搬到了哪里。
          这一步<strong>只读</strong>，不会修改任何文件。
        </p>
      </div>
      <div className="auto-check-banner-action">
        <Button
          variant="primary"
          size="md"
          data-testid="auto-check-button"
          icon={<ScanSearch size={15} />}
          loading={loading}
          disabled={disabled}
          onClick={onCheck}
        >
          {loading ? '正在检查…' : '自动检查项目'}
        </Button>
        <span>不用填写任何路径</span>
      </div>
    </section>
  )
}
