import type { ScanOccurrence } from '@shared/types'

const CSV_HEADER = ['file', 'line', 'rule', 'mode', 'old', 'new', 'context'] as const

/** RFC 4180 quoting: always quote text cells, double embedded quotes. */
function quoteCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function buildScanCsv(items: ScanOccurrence[]): string {
  const lines: string[] = [CSV_HEADER.join(',')]
  for (const item of items) {
    const cells = [
      item.filePath,
      String(item.line),
      item.ruleName,
      item.matchMode,
      item.oldText,
      item.newText,
      item.context
    ]
    lines.push(cells.map(quoteCell).join(','))
  }
  // UTF-8 BOM so Excel opens Chinese context correctly, CRLF per RFC 4180.
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
