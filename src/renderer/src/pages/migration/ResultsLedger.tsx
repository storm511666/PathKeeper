import { useEffect, useRef, type ReactNode } from 'react'
import type { ApplyResult, ScanOccurrence, ScanResult } from '@shared/types'
import {
  Download,
  FolderSearch,
  Search,
  ShieldCheck,
  TriangleAlert,
  X
} from 'lucide-react'
import { cx } from '@renderer/lib/cx'
import { formatCount, formatDuration, formatTime } from '@renderer/lib/format'
import { categoryLabel, matchModeLabel } from '@renderer/lib/labels'
import { Button, Chip, IconButton, RouteMotif, Stat, type ChipTone } from '@renderer/components/ui'
import { HighlightedText } from '@renderer/components/Highlight'

const MODE_TONES: Record<ScanOccurrence['matchMode'], ChipTone> = {
  strict: 'brass',
  basename: 'mint',
  directory: 'neutral'
}

function splitFilePath(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index === -1) return { dir: '', name: filePath }
  return { dir: normalized.slice(0, index + 1), name: normalized.slice(index + 1) }
}

export interface ResultsLedgerProps {
  scan: ScanResult
  items: ScanOccurrence[]
  selected: ReadonlySet<string>
  filter: string
  applied: ApplyResult | null
  exporting: boolean
  applyDisabled: boolean
  applyDisabledReason: string | null
  onFilterChange: (value: string) => void
  onToggle: (id: string) => void
  onSelectAll: () => void
  onSelectNone: () => void
  onInvert: () => void
  onExport: () => void
  onApply: () => void
  onRevealFile: (filePath: string) => void
}

export function ResultsLedger({
  scan,
  items,
  selected,
  filter,
  applied,
  exporting,
  applyDisabled,
  applyDisabledReason,
  onFilterChange,
  onToggle,
  onSelectAll,
  onSelectNone,
  onInvert,
  onExport,
  onApply,
  onRevealFile
}: ResultsLedgerProps): ReactNode {
  const selectAllRef = useRef<HTMLInputElement | null>(null)
  const selectedTotal = selected.size
  const visibleSelected = items.reduce((count, item) => count + (selected.has(item.id) ? 1 : 0), 0)
  const allVisibleSelected = items.length > 0 && visibleSelected === items.length
  const partiallySelected = visibleSelected > 0 && !allVisibleSelected
  const matchFiles = new Set(scan.items.map((item) => item.filePath)).size

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = partiallySelected
  }, [partiallySelected])

  const applyTitle = applyDisabledReason ?? undefined
  const exportLabel = selectedTotal > 0 ? `导出选中 (${formatCount(selectedTotal)})` : '导出全部'
  const empty = scan.items.length === 0

  return (
    <section className="ledger" aria-label="扫描结果台账" data-testid="scan-results">
      <header className="ledger-head">
        <div className="ledger-title-group">
          <p className="plate-kicker mono">03 / 扫描结果</p>
          <h2 className="ledger-title" id="scan-results-heading" tabIndex={-1}>
            引用台账
          </h2>
          <p className="ledger-sub">
            {formatTime(scan.createdAt)} 完成 · 未写入任何文件 · 忽略 {formatCount(scan.ignoredFiles)} 个文件
          </p>
        </div>
        <div className="scan-summary" data-testid="scan-summary">
          <Stat value={formatCount(scan.items.length)} label="处匹配" tone="brass" />
          <Stat value={formatCount(matchFiles)} label="涉及文件" />
          <Stat value={formatCount(scan.scannedFiles)} label="已读文件" />
          {scan.skippedFiles > 0 ? <Stat value={formatCount(scan.skippedFiles)} label="跳过文件" tone="muted" /> : null}
          <Stat value={formatDuration(scan.durationMs)} label="用时" tone="muted" />
        </div>
      </header>

      {scan.warnings.length > 0 ? (
        <details className="scan-warnings">
          <summary>
            <TriangleAlert size={13} aria-hidden="true" />
            {scan.warnings.length} 条扫描警告（不影响已列出的匹配）
          </summary>
          <ul>
            {scan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {empty ? (
        <div className="ledger-empty" data-testid="scan-empty">
          <RouteMotif variant="scan" />
          <div className="ledger-empty-copy">
            <h3>没有发现可替换的引用</h3>
            <p>
              已扫描 {formatCount(scan.scannedFiles)} 个文件，没有文本引用当前旧路径。可以检查旧路径拼写、
              开启更多匹配范围，或确认相关文件所在的目录没有被忽略规则跳过。
            </p>
            <p className="ledger-empty-note">本次扫描未写入任何文件。</p>
          </div>
        </div>
      ) : (
        <>
      <div className="ledger-toolbar">
        <div className="ledger-search">
          <Search size={14} className="ledger-search-icon" aria-hidden="true" />
          <input
            className="input input-search"
            type="search"
            value={filter}
            placeholder="筛选文件、规则或路径…"
            aria-label="筛选扫描结果"
            onChange={(event) => onFilterChange(event.target.value)}
          />
          {filter ? (
            <button
              type="button"
              className="input-clear"
              aria-label="清除筛选"
              onClick={() => onFilterChange('')}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div className="ledger-select-tools">
          <span className="selection-count">
            已选 <strong>{formatCount(selectedTotal)}</strong> / {formatCount(scan.items.length)}
            {filter ? <span className="selection-filtered">（显示 {formatCount(items.length)}）</span> : null}
          </span>
          <Button variant="ghost" size="sm" onClick={onSelectAll} disabled={items.length === 0}>
            全选
          </Button>
          <Button variant="ghost" size="sm" onClick={onSelectNone} disabled={selectedTotal === 0}>
            全不选
          </Button>
          <Button variant="ghost" size="sm" onClick={onInvert} disabled={items.length === 0}>
            反选
          </Button>
        </div>

        <div className="ledger-actions">
          <Button
            variant="default"
            size="sm"
            icon={<Download size={14} />}
            loading={exporting}
            onClick={onExport}
          >
            {exportLabel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<ShieldCheck size={14} />}
            data-testid="apply-button"
            disabled={applyDisabled || selectedTotal === 0}
            title={applyTitle}
            onClick={onApply}
          >
            应用选中 ({formatCount(selectedTotal)})
          </Button>
        </div>
      </div>

      {applied && applyDisabledReason ? (
        <p className="ledger-note" role="note">
          {applyDisabledReason}
        </p>
      ) : null}

      <div className="table-wrap">
        <table className="ledger-table">
          <caption className="sr-only">扫描到的路径引用，可勾选后应用</caption>
          <colgroup>
            <col className="col-check" />
            <col className="col-location" />
            <col className="col-rule" />
            <col className="col-old" />
            <col className="col-new" />
            <col className="col-context" />
            <col className="col-mode" />
            <col className="col-row-action" />
          </colgroup>
          <thead>
            <tr>
              <th className="col-check">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  data-testid="select-all"
                  className="checkbox"
                  checked={allVisibleSelected}
                  aria-label="全选当前筛选结果"
                  onChange={(event) => {
                    if (event.target.checked) onSelectAll()
                    else onSelectNone()
                  }}
                />
              </th>
              <th scope="col">文件位置</th>
              <th scope="col">规则</th>
              <th scope="col">旧路径</th>
              <th scope="col">新路径</th>
              <th scope="col">上下文</th>
              <th scope="col">匹配</th>
              <th className="col-row-action">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const isSelected = selected.has(item.id)
              const location = splitFilePath(item.filePath)
              return (
                <tr
                  key={item.id}
                  data-testid="result-row"
                  className={cx('ledger-row', isSelected && 'is-selected')}
                >
                  <td className="col-check">
                    <input
                      type="checkbox"
                      data-testid="result-checkbox"
                      className="checkbox"
                      checked={isSelected}
                      aria-label={`选择 ${item.filePath} 第 ${item.line} 行`}
                      onChange={() => onToggle(item.id)}
                    />
                  </td>
                  <td className="col-location">
                    <span className="loc mono" title={`${item.filePath}:${item.line}`}>
                      <span className="loc-dir">{location.dir}</span>
                      <span className="loc-name">{location.name}</span>
                      <span className="loc-line">:{item.line}</span>
                    </span>
                  </td>
                  <td className="col-rule">
                    <span className="rule-name">{item.ruleName}</span>
                    <Chip tone="muted" mono>
                      {categoryLabel(item.ruleCategory)}
                    </Chip>
                  </td>
                  <td className="col-old">
                    <code className="path-old mono" title={item.oldText}>
                      {item.oldText}
                    </code>
                  </td>
                  <td className="col-new">
                    <code className="path-new mono" title={item.newText}>
                      {item.newText}
                    </code>
                  </td>
                  <td className="col-context">
                    <code className="context mono" title={item.context}>
                      <HighlightedText text={item.context} needle={item.oldText} />
                    </code>
                  </td>
                  <td className="col-mode">
                    <Chip tone={MODE_TONES[item.matchMode]} mono>
                      {matchModeLabel(item.matchMode)}
                    </Chip>
                  </td>
                  <td className="col-row-action">
                    <IconButton
                      label={`在资源管理器中定位 ${item.filePath}`}
                      className="row-action"
                      onClick={() => onRevealFile(item.filePath)}
                    >
                      <FolderSearch size={14} />
                    </IconButton>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {items.length === 0 ? (
          <p className="table-empty">
            {filter ? '没有与筛选条件匹配的行。' : '这批扫描没有发现可替换的路径引用。'}
          </p>
        ) : null}
      </div>

      <footer className="ledger-foot">
        <span>
          合计 <strong>{formatCount(scan.items.length)}</strong> 处引用 / <strong>{formatCount(matchFiles)}</strong>{' '}
          个文件
        </span>
        <span className="ledger-foot-hint">写入前请核对上下文；勾选行会分别改写，未勾选的行保持不变。</span>
      </footer>
        </>
      )}
    </section>
  )
}
