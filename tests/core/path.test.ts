import { afterEach, describe, expect, it } from 'vitest'
import {
  CoreError,
  isCoreError,
  isInside,
  normalizeSlashes,
  relativeBaseName,
  relativeDirName,
  resolveMigrationPaths,
  tryStatKind,
  toProjectRelative
} from '../../src/main/core'
import { cleanupTempProjects, createTempProject } from './helpers'

afterEach(cleanupTempProjects)

function coreErrorCode(action: () => unknown): string | null {
  try {
    action()
    return null
  } catch (error) {
    return isCoreError(error) ? error.code : 'NOT_CORE_ERROR'
  }
}

describe('normalizeSlashes', () => {
  it('converts backslashes to forward slashes and collapses duplicates', () => {
    expect(normalizeSlashes(String.raw`C:\assets\\images\logo.png`)).toBe('C:/assets/images/logo.png')
    expect(normalizeSlashes('a//b///c')).toBe('a/b/c')
  })

  it('drops a trailing separator but keeps filesystem roots', () => {
    expect(normalizeSlashes('assets/images/')).toBe('assets/images')
    expect(normalizeSlashes('/')).toBe('/')
    expect(normalizeSlashes('C:/')).toBe('C:/')
  })

  it('preserves UNC leading double slashes', () => {
    expect(normalizeSlashes(String.raw`\\server\share\folder`)).toBe('//server/share/folder')
  })

  it('returns an empty string for non-string input', () => {
    expect(normalizeSlashes(undefined as unknown as string)).toBe('')
  })
})

describe('isInside', () => {
  it('accepts the root itself and nested paths', async () => {
    const project = await createTempProject()
    const root = project.root
    expect(isInside(root, root)).toBe(true)
    expect(isInside(root, project.absolute('assets/images/logo.png'))).toBe(true)
  })

  it('rejects sibling prefixes and parent paths', async () => {
    const project = await createTempProject()
    expect(isInside(project.root, `${project.root}-sibling/file.png`)).toBe(false)
    expect(isInside(project.root, project.absolute('..'))).toBe(false)
    expect(isInside(project.root, project.absolute('../outside.png'))).toBe(false)
  })
})

describe('toProjectRelative', () => {
  it('returns POSIX project-relative paths', async () => {
    const project = await createTempProject({ 'assets/images/logo.png': 'x' })
    expect(toProjectRelative(project.root, project.absolute('assets/images/logo.png'))).toBe(
      'assets/images/logo.png'
    )
    expect(toProjectRelative(project.root, project.root)).toBe('')
  })

  it('keeps ../ segments for paths outside the root', async () => {
    const project = await createTempProject()
    expect(toProjectRelative(project.root, project.absolute('../outside.png'))).toBe(
      '../outside.png'
    )
  })
})

describe('relative path helpers', () => {
  it('splits base names and dir names', () => {
    expect(relativeBaseName('assets/images/logo.png')).toBe('logo.png')
    expect(relativeBaseName('logo.png')).toBe('logo.png')
    expect(relativeDirName('assets/images/logo.png')).toBe('assets/images')
    expect(relativeDirName('logo.png')).toBe('')
  })
})

describe('resolveMigrationPaths', () => {
  it('resolves relative inputs and infers file kind from the existing old path', async () => {
    const project = await createTempProject({ 'assets/old.png': 'x', 'media/.keep': '' })
    const info = resolveMigrationPaths(project.root, 'assets/old.png', 'media/new.png', 'auto')
    expect(info.kind).toBe('file')
    expect(info.oldRel).toBe('assets/old.png')
    expect(info.newRel).toBe('media/new.png')
    expect(info.oldName).toBe('old.png')
    expect(info.newName).toBe('new.png')
    expect(info.oldAbs).toBe(project.absolute('assets/old.png'))
    expect(info.newAbs).toBe(project.absolute('media/new.png'))
    expect(info.warnings.join('\n')).not.toContain('旧路径当前不存在')
    expect(info.warnings.join('\n')).toContain('新路径当前不存在')
  })

  it('accepts absolute inputs and normalizes their separators', async () => {
    const project = await createTempProject({ 'assets/old.png': 'x' })
    const info = resolveMigrationPaths(
      project.root,
      project.absolute('assets/old.png'),
      project.absolute('media/new.png').replace(/\//g, '\\'),
      'file'
    )
    expect(info.oldRel).toBe('assets/old.png')
    expect(info.newRel).toBe('media/new.png')
  })

  it('treats a leading slash as project-relative input', async () => {
    const project = await createTempProject({ 'assets/old.png': 'x' })
    const info = resolveMigrationPaths(project.root, '/assets/old.png', '/media/new.png', 'file')
    expect(info.oldRel).toBe('assets/old.png')
    expect(info.newRel).toBe('media/new.png')
  })

  it('strips wrapping quotes from typed inputs', async () => {
    const project = await createTempProject({ 'assets/old.png': 'x' })
    const info = resolveMigrationPaths(project.root, '"assets/old.png"', "'media/new.png'", 'file')
    expect(info.oldRel).toBe('assets/old.png')
    expect(info.newRel).toBe('media/new.png')
  })

  it('normalizes dot segments in relative inputs', async () => {
    const project = await createTempProject({ 'assets/old.png': 'x' })
    const info = resolveMigrationPaths(
      project.root,
      String.raw`assets\sub\..\old.png`,
      'media/new.png',
      'file'
    )
    expect(info.oldRel).toBe('assets/old.png')
  })

  it('infers directory kind from the new path when the old path is gone', async () => {
    const project = await createTempProject({ 'media/newdir/.keep': '' })
    const info = resolveMigrationPaths(project.root, 'assets/olddir', 'media/newdir', 'auto')
    expect(info.kind).toBe('directory')
    expect(info.warnings.join('\n')).toContain('原始路径不存在')
  })

  it('infers directory kind from trailing separators when neither path exists', async () => {
    const project = await createTempProject()
    const info = resolveMigrationPaths(project.root, 'assets/olddir/', 'media/newdir/', 'auto')
    expect(info.kind).toBe('directory')
    expect(info.warnings.join('\n')).toContain('旧路径当前不存在')
  })

  it('infers file kind from the extension as a last resort', async () => {
    const project = await createTempProject()
    const info = resolveMigrationPaths(project.root, 'assets/old.bin', 'media/new.bin', 'auto')
    expect(info.kind).toBe('file')
  })

  it('honours an explicit kind and warns when it contradicts the filesystem', async () => {
    const project = await createTempProject({ 'assets/old.png': 'x' })
    const info = resolveMigrationPaths(project.root, 'assets/old.png', 'media/new.png', 'directory')
    expect(info.kind).toBe('directory')
    expect(info.warnings.join('\n')).toContain('与所选类型不一致')
  })

  it('allows case-only renames and nested moves', async () => {
    const project = await createTempProject({ 'assets/Logo.png': 'x' })
    const rename = resolveMigrationPaths(project.root, 'assets/Logo.png', 'assets/logo.png', 'file')
    expect(rename.oldRel).toBe('assets/Logo.png')
    expect(rename.newRel).toBe('assets/logo.png')

    const nested = resolveMigrationPaths(project.root, 'assets', 'backup/assets', 'directory')
    expect(nested.oldRel).toBe('assets')
    expect(nested.newRel).toBe('backup/assets')
  })

  it('reports a missing old path in warnings', async () => {
    const project = await createTempProject({ 'media/new.png': 'x' })
    const info = resolveMigrationPaths(project.root, 'gone/old.png', 'media/new.png', 'file')
    expect(info.warnings.join('\n')).toContain('旧路径当前不存在')
  })

  it('rejects empty inputs', async () => {
    const project = await createTempProject()
    expect(coreErrorCode(() => resolveMigrationPaths(project.root, '', 'media/new.png', 'auto'))).toBe(
      'EMPTY_PATH'
    )
    expect(
      coreErrorCode(() => resolveMigrationPaths(project.root, 'assets/old.png', '  ', 'auto'))
    ).toBe('EMPTY_PATH')
  })

  it('rejects paths outside the project root', async () => {
    const project = await createTempProject({ 'assets/old.png': 'x' })
    expect(
      coreErrorCode(() =>
        resolveMigrationPaths(project.root, String.raw`..\outside\old.png`, 'media/new.png', 'file')
      )
    ).toBe('PATH_OUTSIDE_PROJECT')
    expect(
      coreErrorCode(() =>
        resolveMigrationPaths(project.root, 'assets/old.png', project.absolute('../escape.png'), 'file')
      )
    ).toBe('PATH_OUTSIDE_PROJECT')
  })

  it('rejects the project root itself and identical paths', async () => {
    const project = await createTempProject({ 'assets/old.png': 'x' })
    expect(coreErrorCode(() => resolveMigrationPaths(project.root, '.', 'media/new.png', 'auto'))).toBe(
      'PATH_IS_PROJECT_ROOT'
    )
    expect(
      coreErrorCode(() => resolveMigrationPaths(project.root, 'assets/old.png', './assets/old.png', 'file'))
    ).toBe('SAME_PATH')
  })

  it('rejects an empty project root with a typed error', () => {
    expect(
      coreErrorCode(() => resolveMigrationPaths('', 'assets/old.png', 'media/new.png', 'file'))
    ).toBe('INVALID_PROJECT_ROOT')
  })

  it('exposes the thrown error type', async () => {
    const project = await createTempProject()
    let caught: unknown = null
    try {
      resolveMigrationPaths(project.root, '', 'x', 'auto')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CoreError)
    expect(caught).toBeInstanceOf(Error)
  })
})

describe('tryStatKind', () => {
  it('reports file, directory or null', async () => {
    const project = await createTempProject({ 'a.txt': 'x', 'folder/.keep': '' })
    expect(tryStatKind(project.absolute('a.txt'))).toBe('file')
    expect(tryStatKind(project.absolute('folder'))).toBe('directory')
    expect(tryStatKind(project.absolute('missing'))).toBeNull()
  })
})
