import { useEffect, useState, type ReactNode } from 'react'
import type {
  AutoCheckCandidate,
  AutoCheckGroup,
  AutoCheckResult
} from '@shared/types'
import {
  ArrowRight,
  CheckCircle2,
  FileSearch,
  ScanSearch,
  ShieldCheck
} from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import {
  Button,
  Chip,
  InlineError,
  Notice,
  Spinner,
  Stat
} from '@renderer/components/ui'
import {
  UNKNOWN_ENGLISH_TITLE,
  candidateReasonEvidence,
  humanizeFileView
} from '@shared/fileHumanize'

export interface AutoCheckDialogProps {
  open: boolean
  loading: boolean
  result: AutoCheckResult | null
  error: string | null
  /** Beginner mode humanizes missing titles and candidate rows. */
  beginnerMode?: boolean
  onClose: () => void
  onRetry: () => void
  onUse: (group: AutoCheckGroup, candidate: AutoCheckCandidate) => void
}

const REASON_LABEL: Record<AutoCheckCandidate['reason'], string> = {
  'same-name': '同名文件',
  'similar-name': '文件名相近'
}

function candidateReasonTone(reason: AutoCheckCandidate['reason']): 'mint' | 'brass' {
  return reason === 'same-name' ? 'mint' : 'brass'
}

/** Human title shown in beginner mode; falls back to the honest type label. */
function beginnerMissingTitle(group: AutoCheckGroup): string {
  const view = humanizeFileView(group.missingPath)
  return view.title === UNKNOWN_ENGLISH_TITLE
    ? `找不到这个「${view.typeLabel}」`
    : `找不到这张「${view.title}」`
}

export function AutoCheckDialog({
  open,
  loading,
  result,
  error,
  beginnerMode = false,
  onClose,
  onRetry,
  onUse
}: AutoCheckDialogProps): ReactNode {
  const [selected, setSelected] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!result) {
      setSelected({})
      return
    }
    const next: Record<string, string> = {}
    for (const group of result.groups) {
      const first = group.candidates[0]
      if (first) next[group.missingPath] = first.filePath
    }
    setSelected(next)
  }, [result])

  const description = loading
    ? '正在读取项目文件并检查路径引用，只读操作，不会修改任何文件。'
    : '这是只读检查。找到的“可能新位置”只是建议，最终仍需你核对后再扫描、确认写入。'

  return (
    <Modal
      open={open}
      title="自动检查项目"
      description={description}
      onClose={onClose}
      width="lg"
      testId="auto-check-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onRetry} disabled={loading} icon={<ScanSearch size={14} />}>
            重新检查
          </Button>
          <Button variant="default" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className="auto-check-dialog">
        {loading ? (
          <div className="auto-check-loading" data-testid="auto-check-loading">
            <Spinner label="正在逐文件检查，请稍候…" />
            <p>检查期间不会写入任何文件。项目文件多时可能需要几秒钟。</p>
          </div>
        ) : error ? (
          <InlineError message={error} />
        ) : result ? (
          <>
            <div className="auto-check-stats">
              <Stat label="检查文件" value={result.checkedFiles} />
              <Stat label="发现路径引用" value={result.referenceCount} />
              <Stat
                label="找不到目标的引用"
                value={result.brokenReferenceCount}
                tone={result.brokenReferenceCount > 0 ? 'red' : 'mint'}
              />
            </div>

            <div className="auto-check-terms">
              <span>
                <strong>旧路径</strong> = 文件原来在哪（现在这里找不到文件）
              </span>
              <span>
                <strong>新路径</strong> = 软件猜它现在在哪（需要你核对）
              </span>
            </div>

            {result.groups.length === 0 ? (
              <div className="auto-check-empty" data-testid="auto-check-empty">
                <span className="auto-check-empty-icon" aria-hidden="true">
                  <CheckCircle2 size={28} />
                </span>
                <div>
                  <h3>没有发现断开的路径引用</h3>
                  <p>
                    项目里目前被识别到的路径都能找到对应文件。
                    如果你刚刚移动了文件却看到这个结果，请确认移动的是<strong>这个项目内部</strong>
                    的文件，并且文件确实已经不在原位置。
                  </p>
                </div>
              </div>
            ) : (
              <>
                <Notice
                  tone="info"
                  compact
                  icon={<ShieldCheck size={15} />}
                  title="先核对，再修复"
                >
                  软件按“文件名 + 路径相似度”猜出可能的新位置。它不会替你修改文件；
                  选择正确的一项后，会先填入迁移路线并进入只读扫描，你仍需要检查并确认写入。
                </Notice>

                <div className="auto-check-group-list">
                  {result.groups.map((group, groupIndex) => {
                    const selectedPath = selected[group.missingPath]
                    const selectedCandidate =
                      group.candidates.find((candidate) => candidate.filePath === selectedPath) ??
                      null
                    const missingView = humanizeFileView(group.missingPath)
                    return (
                      <section
                        className="auto-check-group"
                        key={group.missingPath}
                        data-testid="auto-check-group"
                      >
                        <header className="auto-check-group-head">
                          <div className="auto-check-group-title">
                            <span className="auto-check-group-index mono">
                              {String(groupIndex + 1).padStart(2, '0')}
                            </span>
                            <div>
                              <p
                                className="auto-check-group-label"
                                data-testid={
                                  beginnerMode ? 'autocheck-human-title' : undefined
                                }
                              >
                                {beginnerMode
                                  ? beginnerMissingTitle(group)
                                  : '现在找不到这个文件'}
                              </p>
                              {beginnerMode ? (
                                <>
                                  <p className="auto-check-group-human">
                                    它是：{missingView.typeLabel} · {missingView.explanation}
                                  </p>
                                  <nav
                                    className="auto-check-breadcrumb"
                                    aria-label="文件位置"
                                  >
                                    {missingView.pathBreadcrumb}
                                  </nav>
                                  <details className="auto-check-raw-path">
                                    <summary>原始路径</summary>
                                    <code className="auto-check-missing mono">
                                      {group.missingPath}
                                    </code>
                                  </details>
                                </>
                              ) : (
                                <code className="auto-check-missing mono">
                                  {group.missingPath}
                                </code>
                              )}
                            </div>
                          </div>
                          <Chip tone="red">{group.references.length} 处引用</Chip>
                        </header>

                        {group.candidates.length > 0 ? (
                          <div className="auto-check-suggestion">
                            <p className="auto-check-suggestion-label">
                              <FileSearch size={13} aria-hidden="true" />
                              {beginnerMode
                                ? '找找看，这些文件可能是它，请选一个：'
                                : '软件在项目里找到这些可能的文件，请选一个：'}
                            </p>
                            <div
                              className="auto-check-candidates"
                              role="radiogroup"
                              aria-label={`${group.missingPath} 的可能新位置`}
                            >
                              {group.candidates.map((candidate) => {
                                const isSelected = candidate.filePath === selectedPath
                                const candidateView = humanizeFileView(candidate.filePath)
                                if (!beginnerMode) {
                                  return (
                                    <button
                                      key={candidate.filePath}
                                      type="button"
                                      role="radio"
                                      aria-checked={isSelected}
                                      data-testid="auto-check-candidate"
                                      className={`auto-check-candidate${isSelected ? ' is-selected' : ''}`}
                                      onClick={() =>
                                        setSelected((current) => ({
                                          ...current,
                                          [group.missingPath]: candidate.filePath
                                        }))
                                      }
                                    >
                                      <span className="auto-check-radio" aria-hidden="true" />
                                      <code className="auto-check-candidate-path mono">
                                        {candidate.filePath}
                                      </code>
                                      <Chip tone={candidateReasonTone(candidate.reason)}>
                                        {REASON_LABEL[candidate.reason]}
                                      </Chip>
                                    </button>
                                  )
                                }
                                return (
                                  <div
                                    className={`auto-check-candidate-row${
                                      isSelected ? ' is-selected' : ''
                                    }`}
                                    key={candidate.filePath}
                                  >
                                    <button
                                      type="button"
                                      role="radio"
                                      aria-checked={isSelected}
                                      data-testid="auto-check-candidate"
                                      className={`auto-check-candidate auto-check-candidate-beginner${
                                        isSelected ? ' is-selected' : ''
                                      }`}
                                      onClick={() =>
                                        setSelected((current) => ({
                                          ...current,
                                          [group.missingPath]: candidate.filePath
                                        }))
                                      }
                                    >
                                      <span className="auto-check-radio" aria-hidden="true" />
                                      <span className="auto-check-candidate-body">
                                        <span
                                          className="auto-check-candidate-title"
                                          data-testid="auto-check-candidate-title"
                                        >
                                          {candidateView.title}
                                        </span>
                                        <span className="auto-check-candidate-summary">
                                          {candidateView.typeLabel} ·{' '}
                                          {candidateView.pathBreadcrumb}
                                        </span>
                                        <span className="auto-check-candidate-why">
                                          为什么推荐：
                                          {candidateReasonEvidence(candidate.reason)}
                                        </span>
                                        <span className="sr-only">
                                          {candidate.filePath}
                                        </span>
                                      </span>
                                      <Chip tone={candidateReasonTone(candidate.reason)}>
                                        {REASON_LABEL[candidate.reason]}
                                      </Chip>
                                    </button>
                                    <details className="auto-check-candidate-raw">
                                      <summary>原始路径</summary>
                                      <code className="mono">{candidate.filePath}</code>
                                    </details>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : (
                          <Notice tone="warn" compact title="没有找到相似文件">
                            这个文件可能还没有放回项目，或者新文件不在当前项目目录里。
                            你也可以手动在项目文件夹中找一找，再回到迁移页填写路径。
                          </Notice>
                        )}

                        <details className="auto-check-refs">
                          <summary>
                            查看引用位置（{group.references.length} 处）
                          </summary>
                          <ul>
                            {group.references.map((reference) => (
                              <li key={reference.id}>
                                <code className="auto-check-ref-location mono">
                                  {reference.filePath}:{reference.line}
                                </code>
                                <span className="auto-check-ref-rule">{reference.ruleName}</span>
                                <span className="auto-check-ref-context mono">
                                  {reference.context}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </details>

                        <div className="auto-check-group-actions">
                          <p>
                            {beginnerMode ? '选好后会填入：原位置' : '选好后会填入：旧路径'}{' '}
                            <code>{group.missingPath}</code>
                            {selectedCandidate ? (
                              <>
                                {' '}→ {beginnerMode ? '新位置' : '新路径'}{' '}
                                <code>{selectedCandidate.filePath}</code>
                              </>
                            ) : null}
                          </p>
                          <Button
                            variant="primary"
                            size="sm"
                            data-testid="auto-check-use"
                            icon={<ArrowRight size={14} />}
                            disabled={!selectedCandidate}
                            onClick={() => {
                              if (selectedCandidate) onUse(group, selectedCandidate)
                            }}
                          >
                            用这个新位置继续扫描
                          </Button>
                        </div>
                      </section>
                    )
                  })}
                </div>

                {result.warnings.length > 0 ? (
                  <details className="auto-check-warnings">
                    <summary>检查过程中的 {result.warnings.length} 条提示</summary>
                    <ul>
                      {result.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  )
}
