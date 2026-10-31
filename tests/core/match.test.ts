import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyzeReference,
  evaluateReference,
  formatReplacement,
  matchReference,
  resolveReferenceCandidates,
  unescapeJsonPath,
  type MigrationTarget
} from '../../src/main/core'
import type { MatchModes, PathKind } from '../../src/shared/types'

const isWindows = process.platform === 'win32'
const PROJECT_ROOT = isWindows ? 'C:\\proj' : nodePath.resolve('/tmp/proj')

function makeTarget(
  overrides: Partial<MigrationTarget> & { oldRel: string; newRel: string }
): MigrationTarget {
  const oldName = overrides.oldRel.split('/').filter(Boolean).pop() ?? ''
  const newName = overrides.newRel.split('/').filter(Boolean).pop() ?? ''
  return {
    projectRoot: PROJECT_ROOT,
    kind: 'file' as PathKind,
    modes: { strict: true, basename: true, directory: true },
    caseSensitive: false,
    ...overrides,
    oldName: overrides.oldName ?? oldName,
    newName: overrides.newName ?? newName
  }
}

function modes(overrides: Partial<MatchModes>): MatchModes {
  return { strict: false, basename: false, directory: false, ...overrides }
}

function replace(
  raw: string,
  sourceFile: string,
  target: MigrationTarget
): string | null {
  return evaluateReference(raw, sourceFile, target)?.newText ?? null
}

describe('analyzeReference — reference style detection', () => {
  it('classifies project-root-relative paths', () => {
    const analysis = analyzeReference('assets/logo.png')
    expect(analysis).not.toBeNull()
    expect(analysis?.style).toBe('root-relative')
    expect(analysis?.separator).toBe('/')
    expect(analysis?.posix).toBe('assets/logo.png')
    expect(analysis?.jsonEscaped).toBe(false)
  })

  it('classifies ./ and ../ references as source-relative', () => {
    const dot = analyzeReference('./img/logo.png')
    expect(dot?.style).toBe('source-relative')
    expect(dot?.hasDotPrefix).toBe(true)

    const parent = analyzeReference(String.raw`..\img\logo.png`)
    expect(parent?.style).toBe('source-relative')
    expect(parent?.separator).toBe('\\')
    expect(parent?.posix).toBe('../img/logo.png')
  })

  it('classifies absolute Windows and UNC paths', () => {
    const windows = analyzeReference(String.raw`C:\proj\assets\logo.png`)
    expect(windows?.style).toBe('absolute')
    expect(windows?.separator).toBe('\\')

    const forward = analyzeReference('C:/proj/assets/logo.png')
    expect(forward?.style).toBe('absolute')
    expect(forward?.separator).toBe('/')

    const unc = analyzeReference(String.raw`\\server\share\proj\logo.png`)
    expect(unc?.style).toBe('absolute')
  })

  it('classifies web-root style with a single leading slash or backslash', () => {
    expect(analyzeReference('/assets/logo.png')?.style).toBe('web-root')
    expect(analyzeReference(String.raw`\assets\logo.png`)?.style).toBe('web-root')
  })

  it('classifies bare basenames', () => {
    const analysis = analyzeReference('logo.png')
    expect(analysis?.style).toBe('basename')
    expect(analysis?.posix).toBe('logo.png')
  })

  it('detects JSON-escaped backslashes and unescapes them for analysis', () => {
    const analysis = analyzeReference(String.raw`C:\\proj\\assets\\logo.png`)
    expect(analysis?.jsonEscaped).toBe(true)
    expect(analysis?.logical).toBe(String.raw`C:\proj\assets\logo.png`)
    expect(analysis?.style).toBe('absolute')
  })

  it('does not confuse a plain Windows path containing \\n with a JSON escape', () => {
    const analysis = analyzeReference(String.raw`C:\new\assets\logo.png`)
    expect(analysis?.jsonEscaped).toBe(false)
    expect(analysis?.logical).toBe(String.raw`C:\new\assets\logo.png`)
  })

  it('keeps query strings and fragments as a suffix', () => {
    const analysis = analyzeReference('./old.png?v=2#frag')
    expect(analysis?.posix).toBe('old.png')
    expect(analysis?.suffix).toBe('?v=2#frag')
  })

  it('records trailing separators for directory references', () => {
    const analysis = analyzeReference('/assets/models/')
    expect(analysis?.hasTrailingSeparator).toBe(true)
    expect(analysis?.posix).toBe('/assets/models')
  })

  it('unescapes JSON path escapes directly', () => {
    expect(unescapeJsonPath(String.raw`C:\\proj\\a.png`)).toBe(String.raw`C:\proj\a.png`)
    expect(unescapeJsonPath(String.raw`a\/b`)).toBe('a/b')
    expect(unescapeJsonPath(String.raw`C:\plain\a.png`)).toBe(String.raw`C:\plain\a.png`)
  })
})

describe('analyzeReference — candidate rejection', () => {
  const rejected: string[] = [
    '',
    '   ',
    'http://example.com/a.png',
    'https://example.com/a.png?x=1',
    'data:image/png;base64,AAAA',
    'blob:https://example.com/uuid',
    'mailto:someone@example.com',
    '//cdn.example.com/a.png',
    '${ASSETS_DIR}/old.png',
    '%USERPROFILE%\\old.png',
    '{{ projectDir }}/old.png',
    '<file>/old.png',
    'assets/*.png',
    'assets/?.png',
    'a\u0000b.png',
    ' ./assets/old.png '
  ]

  it.each(rejected.map((value) => [JSON.stringify(value), value]))(
    'rejects %s',
    (_label, value) => {
      expect(analyzeReference(value)).toBeNull()
    }
  )
})

describe('matching — strict mode and style-preserving output', () => {
  const target = makeTarget({ oldRel: 'assets/old.png', newRel: 'media/new.png' })

  it('rewrites root-relative references as root-relative', () => {
    expect(replace('assets/old.png', 'docs/readme.md', target)).toBe('media/new.png')
  })

  it('rewrites ./ references relative to the source file when in the same directory', () => {
    const local = makeTarget({ oldRel: 'docs/old.png', newRel: 'docs/img/new.png' })
    expect(replace('./old.png', 'docs/a.md', local)).toBe('./img/new.png')
  })

  it('recomputes parent-relative references from the source file directory', () => {
    const local = makeTarget({ oldRel: 'docs/old.png', newRel: 'media/new.png' })
    expect(replace('../docs/old.png', 'docs/a.md', local)).toBe('../media/new.png')
  })

  it('keeps ./ prefix when the new path does not need parent segments', () => {
    const local = makeTarget({ oldRel: 'docs/img/old.png', newRel: 'docs/img/new.png' })
    expect(replace('./img/old.png', 'docs/a.md', local)).toBe('./img/new.png')
  })

  it('handles references matching via the source-directory interpretation', () => {
    const local = makeTarget({ oldRel: 'docs/assets/old.png', newRel: 'assets/new.png' })
    expect(replace('assets/old.png', 'docs/a.md', local)).toBe('../assets/new.png')
  })

  it('preserves Windows backslash separators', () => {
    expect(replace(String.raw`assets\old.png`, 'docs/a.md', target)).toBe(
      String.raw`media\new.png`
    )
  })

  it('rewrites absolute paths inside the project, preserving separator style', () => {
    const windowsTarget = makeTarget({ oldRel: 'assets/old.png', newRel: 'media/new.png' })
    if (!isWindows) return
    expect(replace(String.raw`C:\proj\assets\old.png`, 'docs/a.md', windowsTarget)).toBe(
      String.raw`C:\proj\media\new.png`
    )
    expect(replace('C:/proj/assets/old.png', 'docs/a.md', windowsTarget)).toBe(
      'C:/proj/media/new.png'
    )
  })

  it('rewrites web-root style references with a leading slash', () => {
    expect(replace('/assets/old.png', 'src/App.vue', target)).toBe('/media/new.png')
  })

  it('keeps JSON escaping for absolute paths', () => {
    if (!isWindows) return
    expect(replace(String.raw`C:\\proj\\assets\\old.png`, 'workflows/flow.json', target)).toBe(
      String.raw`C:\\proj\\media\\new.png`
    )
  })

  it('keeps JSON escaping for relative paths', () => {
    expect(replace(String.raw`assets\\old.png`, 'workflows/flow.json', target)).toBe(
      String.raw`media\\new.png`
    )
  })

  it('preserves query strings and fragments', () => {
    const local = makeTarget({ oldRel: 'docs/old.png', newRel: 'docs/img/new.png' })
    expect(replace('./old.png?v=2', 'docs/a.md', local)).toBe('./img/new.png?v=2')
  })

  it('handles same-directory basename references (strict mode)', () => {
    const local = makeTarget({ oldRel: 'docs/old.png', newRel: 'docs/img/new.png' })
    expect(replace('old.png', 'docs/a.md', local)).toBe('img/new.png')
  })

  it('matches case-insensitively by default and respects caseSensitive', () => {
    expect(replace('ASSETS/OLD.PNG', 'docs/a.md', target)).toBe('media/new.png')
    const sensitive = makeTarget({
      oldRel: 'assets/old.png',
      newRel: 'media/new.png',
      caseSensitive: true
    })
    expect(replace('ASSETS/OLD.PNG', 'docs/a.md', sensitive)).toBeNull()
  })

  it('does not match references outside the project root', () => {
    if (!isWindows) return
    expect(replace(String.raw`D:\other\assets\old.png`, 'docs/a.md', target)).toBeNull()
  })

  it('exposes the winning mode and branch through matchReference', () => {
    const analysis = analyzeReference('assets/old.png')
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const match = matchReference(analysis, 'docs/a.md', target)
    expect(match?.matchMode).toBe('strict')
    expect(match?.branch).toBe('root')
    expect(resolveReferenceCandidates(analysis, 'docs/a.md', PROJECT_ROOT).length).toBeGreaterThan(0)
  })
})

describe('matching — basename fallback recomputes full new paths', () => {
  const target = makeTarget({
    oldRel: 'data/old.png',
    newRel: 'assets/materials/new.png',
    modes: modes({ basename: true })
  })

  it('rewrites parent-relative basename matches relative to the source file', () => {
    expect(replace('../data/old.png', 'scripts/preprocess.py', target)).toBe(
      '../assets/materials/new.png'
    )
  })

  it('rewrites root-relative basename matches to the new project-relative path', () => {
    expect(replace('sub/assets/old.png', 'docs/notes.md', target)).toBe(
      'assets/materials/new.png'
    )
  })

  it('rewrites absolute basename matches to the new absolute target', () => {
    if (!isWindows) return
    expect(replace(String.raw`C:\proj\data\old.png`, 'docs/notes.md', target)).toBe(
      String.raw`C:\proj\assets\materials\new.png`
    )
  })

  it('rewrites web-root basename matches with a leading slash', () => {
    expect(replace('/data/old.png', 'src/App.vue', target)).toBe('/assets/materials/new.png')
  })

  it('replaces only the basename for pure basename references', () => {
    expect(replace('old.png', 'scripts/run.py', target)).toBe('new.png')
  })

  it('skips replacement when the basename is unchanged', () => {
    const sameName = makeTarget({
      oldRel: 'data/old.png',
      newRel: 'assets/materials/old.png',
      modes: modes({ basename: true })
    })
    expect(replace('old.png', 'scripts/run.py', sameName)).toBeNull()
  })

  it('never matches when basename mode is disabled', () => {
    const strictOnly = makeTarget({
      oldRel: 'data/old.png',
      newRel: 'assets/materials/new.png',
      modes: modes({ strict: true })
    })
    expect(replace('sub/assets/old.png', 'docs/notes.md', strictOnly)).toBeNull()
  })
})

describe('matching — directory mode remapping', () => {
  const directoryTarget = makeTarget({
    kind: 'directory',
    oldRel: 'assets/models',
    newRel: 'media/ai'
  })

  it('remaps paths below the moved directory (root-relative)', () => {
    expect(replace('assets/models/x.onnx', 'docs/a.md', directoryTarget)).toBe(
      'media/ai/x.onnx'
    )
  })

  it('remaps paths below the moved directory (source-relative)', () => {
    expect(replace('../assets/models/x.onnx', 'config/pipeline.json', directoryTarget)).toBe(
      '../media/ai/x.onnx'
    )
  })

  it('remaps paths below the moved directory (absolute + JSON escaped)', () => {
    expect(
      replace(String.raw`assets\\models\\x.safetensors`, 'workflows/comfyui.json', directoryTarget)
    ).toBe(String.raw`media\\ai\\x.safetensors`)
  })

  it('preserves the case of the sub-path suffix', () => {
    expect(replace('Assets/Models/Sub/File.bin', 'docs/a.md', directoryTarget)).toBe(
      'media/ai/Sub/File.bin'
    )
  })

  it('matches a reference to the directory itself when only directory mode is on', () => {
    const directoryOnly = makeTarget({
      kind: 'directory',
      oldRel: 'datasets/raw',
      newRel: 'datasets/processed',
      modes: modes({ directory: true })
    })
    expect(replace('datasets/raw', 'configs/train.yaml', directoryOnly)).toBe(
      'datasets/processed'
    )
    expect(replace('/datasets/raw/', 'src/train.py', directoryOnly)).toBe('/datasets/processed/')
    expect(replace('./datasets/raw', 'train.py', directoryOnly)).toBe('./datasets/processed')
  })

  it('is inert for file migrations', () => {
    const fileTarget = makeTarget({
      kind: 'file',
      oldRel: 'assets/models',
      newRel: 'media/ai',
      modes: modes({ directory: true, basename: true })
    })
    expect(replace('assets/models/x.onnx', 'docs/a.md', fileTarget)).toBeNull()
  })

  it('never matches when directory mode is disabled', () => {
    const strictOnly = makeTarget({
      kind: 'directory',
      oldRel: 'assets/models',
      newRel: 'media/ai',
      modes: modes({ strict: true, basename: true })
    })
    expect(replace('assets/models/x.onnx', 'docs/a.md', strictOnly)).toBeNull()
  })
})

describe('matching — safety rails', () => {
  it('never returns a replacement identical to the old text', () => {
    const target = makeTarget({ oldRel: 'assets/old.png', newRel: 'assets/old.png.bak' })
    const analysis = analyzeReference('assets/old.png')
    expect(analysis).not.toBeNull()
    if (!analysis) return
    const match = matchReference(analysis, 'docs/a.md', target)
    expect(match).not.toBeNull()
    // The formatted text differs here; verify the equality guard with a case
    // where old and new basenames are the same and only the directory changed.
    const sameName = makeTarget({
      oldRel: 'docs/old.png',
      newRel: 'media/old.png',
      modes: modes({ basename: true })
    })
    expect(evaluateReference('old.png', 'docs/a.md', sameName)).toBeNull()
  })

  it('returns null for rejected reference types', () => {
    const target = makeTarget({ oldRel: 'assets/old.png', newRel: 'media/new.png' })
    expect(replace('https://example.com/assets/old.png', 'docs/a.md', target)).toBeNull()
    expect(replace('${ROOT}/assets/old.png', 'docs/a.md', target)).toBeNull()
  })

  it('returns the original formatted string through formatReplacement', () => {
    const target = makeTarget({ oldRel: 'assets/old.png', newRel: 'media/new.png' })
    const analysis = analyzeReference('assets/old.png')
    if (!analysis) throw new Error('analysis failed')
    const match = matchReference(analysis, 'docs/a.md', target)
    if (!match) throw new Error('match failed')
    expect(formatReplacement(analysis, match, 'docs/a.md', target)).toBe('media/new.png')
  })
})
