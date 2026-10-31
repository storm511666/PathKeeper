import { Fragment, type ReactNode } from 'react'

/**
 * Renders scan context with every occurrence of the replaced path text marked.
 * If the scanner's context does not contain the exact old text, it degrades to
 * plain text instead of guessing.
 */
export function HighlightedText({ text, needle }: { text: string; needle: string }): ReactNode {
  if (!needle) return text
  const nodes: ReactNode[] = []
  let cursor = 0
  let index = text.indexOf(needle)
  let key = 0
  while (index !== -1 && key < 64) {
    if (index > cursor) {
      nodes.push(<Fragment key={`text-${key}`}>{text.slice(cursor, index)}</Fragment>)
      key += 1
    }
    nodes.push(
      <mark className="ctx-match" key={`mark-${key}`}>
        {needle}
      </mark>
    )
    key += 1
    cursor = index + needle.length
    index = text.indexOf(needle, cursor)
  }
  if (nodes.length === 0) return text
  if (cursor < text.length) {
    nodes.push(<Fragment key={`text-${key}`}>{text.slice(cursor)}</Fragment>)
  }
  return <>{nodes}</>
}
