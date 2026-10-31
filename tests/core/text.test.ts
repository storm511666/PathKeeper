import { describe, expect, it } from 'vitest'
import {
  applyTextEdits,
  buildLineStarts,
  decodeTextBuffer,
  encodeTextBuffer,
  extractLineContext,
  lineColumnAt,
  lineColumnFromStarts,
  looksBinary,
  type TextEdit
} from '../../src/main/core'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

function toUtf16Be(text: string): Buffer {
  const buffer = Buffer.from(text, 'utf16le')
  buffer.swap16()
  return buffer
}

describe('decodeTextBuffer', () => {
  it('decodes plain UTF-8', () => {
    const decoded = decodeTextBuffer(Buffer.from('你好 world\n', 'utf8'))
    expect(decoded).toEqual({ text: '你好 world\n', encoding: 'utf8' })
  })

  it('decodes UTF-8 with BOM and strips the BOM from text', () => {
    const decoded = decodeTextBuffer(Buffer.concat([UTF8_BOM, Buffer.from('hello', 'utf8')]))
    expect(decoded).toEqual({ text: 'hello', encoding: 'utf8-bom' })
  })

  it('decodes UTF-16 LE with BOM', () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello 你好', 'utf16le')])
    const decoded = decodeTextBuffer(buffer)
    expect(decoded).toEqual({ text: 'hello 你好', encoding: 'utf16le' })
  })

  it('decodes UTF-16 BE with BOM', () => {
    const buffer = Buffer.concat([Buffer.from([0xfe, 0xff]), toUtf16Be('hello 你好')])
    const decoded = decodeTextBuffer(buffer)
    expect(decoded).toEqual({ text: 'hello 你好', encoding: 'utf16be' })
  })

  it('detects BOM-less UTF-16 LE heuristically', () => {
    const decoded = decodeTextBuffer(Buffer.from('hello world from utf16', 'utf16le'))
    expect(decoded?.encoding).toBe('utf16le')
    expect(decoded?.text).toBe('hello world from utf16')
  })

  it('decodes empty buffers as empty UTF-8', () => {
    expect(decodeTextBuffer(Buffer.alloc(0))).toEqual({ text: '', encoding: 'utf8' })
  })

  it('rejects NUL-containing binary buffers', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    expect(looksBinary(pngHeader)).toBe(true)
    expect(decodeTextBuffer(pngHeader)).toBeNull()
  })

  it('rejects invalid UTF-8 without NUL bytes', () => {
    expect(decodeTextBuffer(Buffer.from([0x80, 0x81, 0x82]))).toBeNull()
    // GBK encoded "中文" is not valid UTF-8 and cannot be preserved safely.
    expect(decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBeNull()
  })

  it('rejects a UTF-8 BOM file containing NULs', () => {
    expect(decodeTextBuffer(Buffer.concat([UTF8_BOM, Buffer.from([0x61, 0x00])]))).toBeNull()
  })
})

describe('encodeTextBuffer', () => {
  it('round-trips every supported encoding', () => {
    const sample = 'PathKeeper 路径 ./assets/old.png\r\n'
    for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be'] as const) {
      const encoded = encodeTextBuffer(sample, encoding)
      const decoded = decodeTextBuffer(encoded)
      expect(decoded?.encoding).toBe(encoding)
      expect(decoded?.text).toBe(sample)
    }
  })

  it('bytes survive a decode/encode round-trip exactly', () => {
    const utf8Buffer = Buffer.from('a\r\nb', 'utf8')
    expect(encodeTextBuffer(decodeTextBuffer(utf8Buffer)!.text, 'utf8')).toEqual(utf8Buffer)

    const bomBuffer = Buffer.concat([UTF8_BOM, Buffer.from('bom', 'utf8')])
    expect(encodeTextBuffer(decodeTextBuffer(bomBuffer)!.text, 'utf8-bom')).toEqual(bomBuffer)

    const leBuffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('le', 'utf16le')])
    expect(encodeTextBuffer(decodeTextBuffer(leBuffer)!.text, 'utf16le')).toEqual(leBuffer)

    const beBuffer = Buffer.concat([Buffer.from([0xfe, 0xff]), toUtf16Be('be')])
    expect(encodeTextBuffer(decodeTextBuffer(beBuffer)!.text, 'utf16be')).toEqual(beBuffer)
  })

  it('encodes UTF-16 BE with the high byte first (including BOM)', () => {
    expect([...encodeTextBuffer('AB', 'utf16be')]).toEqual([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42])
  })
})

describe('applyTextEdits', () => {
  it('applies multiple replacements and returns the count', () => {
    const text = 'The old.png and old.png were moved.'
    const first = text.indexOf('old.png')
    const second = text.lastIndexOf('old.png')
    const result = applyTextEdits(text, [
      { offset: first, length: 7, oldText: 'old.png', newText: 'new.png' },
      { offset: second, length: 7, oldText: 'old.png', newText: 'new.png' }
    ])
    expect(result.applied).toBe(2)
    expect(result.text).toBe('The new.png and new.png were moved.')
  })

  it('sorts unsorted edits by offset', () => {
    const text = 'aa bb cc'
    const result = applyTextEdits(text, [
      { offset: 6, length: 2, oldText: 'cc', newText: 'XX' },
      { offset: 0, length: 2, oldText: 'aa', newText: 'YY' }
    ])
    expect(result.text).toBe('YY bb XX')
    expect(result.applied).toBe(2)
  })

  it('skips overlapping edits and applies the earlier one', () => {
    const text = 'abcdefghij'
    const result = applyTextEdits(text, [
      { offset: 2, length: 4, oldText: 'cdef', newText: 'X' },
      { offset: 4, length: 2, oldText: 'ef', newText: 'Y' }
    ])
    expect(result.text).toBe('abXghij')
    expect(result.applied).toBe(1)
  })

  it('prefers the longer edit when two edits share a start offset', () => {
    const text = 'abcdefghij'
    const result = applyTextEdits(text, [
      { offset: 2, length: 2, oldText: 'cd', newText: 'AA' },
      { offset: 2, length: 4, oldText: 'cdef', newText: 'BBBB' }
    ])
    expect(result.text).toBe('abBBBBghij')
    expect(result.applied).toBe(1)
  })

  it('handles zero-length insertions', () => {
    const result = applyTextEdits('abcdef', [{ offset: 3, length: 0, oldText: '', newText: 'XX' }])
    expect(result.text).toBe('abcXXdef')
    expect(result.applied).toBe(1)
  })

  it('ignores invalid edits instead of throwing', () => {
    const text = 'abcdef'
    const invalid = [
      { offset: -1, length: 2, oldText: 'ab', newText: 'X' },
      { offset: Number.NaN, length: 2, oldText: 'ab', newText: 'X' },
      { offset: 1.5, length: 2, oldText: 'bc', newText: 'X' },
      { offset: 4, length: 10, oldText: 'ef', newText: 'X' },
      { offset: 0, length: -2, oldText: 'ab', newText: 'X' },
      { offset: 0, length: 1, oldText: 'a', newText: 42 as unknown as string }
    ] as unknown as TextEdit[]
    const result = applyTextEdits(text, invalid)
    expect(result.applied).toBe(0)
    expect(result.text).toBe('abcdef')
  })

  it('is a no-op for empty edit lists or non-string text', () => {
    expect(applyTextEdits('abc', [])).toEqual({ text: 'abc', applied: 0 })
    expect(applyTextEdits('', [])).toEqual({ text: '', applied: 0 })
  })

  it('applies edits at the end of the text', () => {
    const result = applyTextEdits('a.png', [{ offset: 2, length: 3, oldText: 'png', newText: 'jpg' }])
    expect(result.text).toBe('a.jpg')
    expect(result.applied).toBe(1)
  })
})

describe('line and column helpers', () => {
  it('builds line starts for LF and CRLF text', () => {
    expect(buildLineStarts('a\nb\nc')).toEqual([0, 2, 4])
    expect(buildLineStarts('a\r\nb\r\nc')).toEqual([0, 3, 6])
    expect(buildLineStarts('')).toEqual([0])
  })

  it('computes 1-based line/column from offsets', () => {
    const starts = buildLineStarts('alpha\nbeta\ngamma')
    expect(lineColumnFromStarts(starts, 0)).toEqual({ line: 1, column: 1 })
    expect(lineColumnFromStarts(starts, 5)).toEqual({ line: 1, column: 6 })
    expect(lineColumnFromStarts(starts, 6)).toEqual({ line: 2, column: 1 })
    expect(lineColumnFromStarts(starts, 10)).toEqual({ line: 2, column: 5 })
    expect(lineColumnFromStarts(starts, 11)).toEqual({ line: 3, column: 1 })
    expect(lineColumnAt('alpha\nbeta', 6)).toEqual({ line: 2, column: 1 })
  })

  it('extracts up to 50 characters of single-line context on each side', () => {
    const before = 'x'.repeat(80)
    const after = 'y'.repeat(80)
    const text = `${before}old.png${after}`
    const offset = before.length
    const starts = buildLineStarts(text)
    const context = extractLineContext(text, starts, offset, 'old.png'.length)
    expect(context).toBe(`${'x'.repeat(50)}old.png${'y'.repeat(50)}`)
    expect(context.length).toBe(107)
  })

  it('never crosses line boundaries and drops CR characters', () => {
    const text = 'first line\r\nA ./assets/old.png B\r\nlast line'
    const offset = text.indexOf('old.png')
    const context = extractLineContext(text, buildLineStarts(text), offset, 'old.png'.length)
    expect(context).toContain('./assets/old.png')
    expect(context).not.toContain('\r')
    expect(context).not.toContain('\n')
    expect(context).not.toContain('first line')
    expect(context).not.toContain('last line')
  })

  it('clamps context at the start and end of a line', () => {
    const text = 'old.png at line start\nand end old.png'
    const starts = buildLineStarts(text)
    const first = extractLineContext(text, starts, 0, 'old.png'.length)
    expect(first).toBe('old.png at line start')
    const secondOffset = text.indexOf('old.png', 5)
    const second = extractLineContext(text, starts, secondOffset, 'old.png'.length)
    expect(second).toBe('and end old.png')
  })
})
