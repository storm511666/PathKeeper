/**
 * Software target resolution + read-only Windows file-version metadata.
 *
 * This module is the Node-only service helper behind “扫描一个软件”. It turns a
 * user-selected `.exe` / `.lnk` / install directory into a validated
 * `{ rootPath, entryPath }` pair, and reads the program's version metadata via
 * a single, read-only PowerShell metadata query. It never starts the selected
 * software, never writes, never installs or downloads anything, and never asks
 * for elevation.
 *
 * No Electron imports live here so the logic can be unit-tested directly.
 */

import { execFile } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import nodePath from 'node:path'
import type { SoftwareInfo, SoftwareInspectResult } from '../../shared/types'
import { errorMessage, isAbortError } from '../core/errors'
import { parseShortcutFile } from '../core/winShortcut'

/** Stable error codes the service maps onto `AppError` / IPC error envelopes. */
export type SoftwareTargetErrorCode =
  | 'SOFTWARE_TARGET_INVALID'
  | 'SOFTWARE_SYSTEM_DIRECTORY'
  | 'FILE_NOT_FOUND'

/** Thrown for unusable software targets; `message` is always user-facing Chinese. */
export class SoftwareTargetError extends Error {
  readonly code: SoftwareTargetErrorCode

  constructor(code: SoftwareTargetErrorCode, message: string) {
    super(message)
    this.name = 'SoftwareTargetError'
    this.code = code
  }
}

export function isSoftwareTargetError(value: unknown): value is SoftwareTargetError {
  return value instanceof SoftwareTargetError
}

export interface ParsedSoftwareTarget {
  /** Absolute install directory that will be scanned. */
  rootPath: string
  /** Absolute entry program (`.exe`) when one could be determined. */
  entryPath: string | null
  kindHint: 'exe' | 'directory' | 'shortcut'
  /** Chinese, non-fatal observations (e.g. “多个 exe，已默认选择一个”). */
  warnings: string[]
}

export interface ParseSoftwareTargetOptions {
  /** Test seam only; defaults to `process.platform`. */
  platform?: NodeJS.Platform
}

export interface SoftwareVersionInfo {
  productName: string | null
  fileDescription: string | null
  productVersion: string | null
  companyName: string | null
}

export interface ReadFileVersionInfoOptions {
  /** Defaults to 5000 ms. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Test seam only; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Test seam only; defaults to the system Windows PowerShell. */
  powershellPath?: string
}

export interface InspectSoftwareOptions extends ReadFileVersionInfoOptions {}

const EMPTY_VERSION_INFO: SoftwareVersionInfo = {
  productName: null,
  fileDescription: null,
  productVersion: null,
  companyName: null
}
const VERSION_INFO_TIMEOUT_MS = 5000
const MAX_VERSION_FIELD_CHARS = 256
const UNINSTALL_LIKE = /^(unins|uninstall|uninst|setup|installer|install|update|updater|patcher|crash|report|helper|repair)/

function emptyVersionInfo(): SoftwareVersionInfo {
  return { ...EMPTY_VERSION_INFO }
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

/** Case-insensitive “same path or inside” check for Windows-style paths. */
function normalizeComparePath(value: string): string {
  return nodePath
    .resolve(value)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function isSameOrInside(root: string, candidate: string): boolean {
  const rootValue = normalizeComparePath(root)
  const candidateValue = normalizeComparePath(candidate)
  return candidateValue === rootValue || candidateValue.startsWith(`${rootValue}/`)
}

function isSamePath(left: string, right: string): boolean {
  return normalizeComparePath(left) === normalizeComparePath(right)
}

function windowsSystemRoots(platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return []
  const roots = new Set<string>()
  for (const key of ['SystemRoot', 'windir']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length > 0) roots.add(value.trim())
  }
  roots.add('C:\\Windows')
  return [...roots]
}

function isDriveRoot(value: string): boolean {
  const parsed = nodePath.parse(nodePath.resolve(value))
  return parsed.root === nodePath.resolve(value)
}

/** Reject system-level / overly broad locations before any scan starts. */
function assertSafeSoftwareRoot(rootPath: string, platform: NodeJS.Platform): void {
  const resolved = nodePath.resolve(rootPath)
  if (isDriveRoot(resolved)) {
    throw new SoftwareTargetError(
      'SOFTWARE_TARGET_INVALID',
      '不能选择磁盘根目录作为软件目录，请选择具体软件所在的文件夹。'
    )
  }
  for (const systemRoot of windowsSystemRoots(platform)) {
    if (isSameOrInside(systemRoot, resolved)) {
      throw new SoftwareTargetError(
        'SOFTWARE_SYSTEM_DIRECTORY',
        '这是 Windows 系统目录，不能作为软件目录；请选择具体软件的安装路径。'
      )
    }
  }
  // Only the profile *root* is rejected: programs installed under the profile
  // (e.g. %LOCALAPPDATA%\Programs\App) are perfectly normal targets.
  if (isSamePath(homedir(), resolved)) {
    throw new SoftwareTargetError(
      'SOFTWARE_TARGET_INVALID',
      '这是用户主目录，范围太大，请选择具体软件的安装文件夹。'
    )
  }
}

function executableScore(fileName: string, directoryName: string): number {
  const lower = fileName.toLowerCase()
  const stem = lower.endsWith('.exe') ? lower.slice(0, -4) : lower
  if (stem === directoryName.toLowerCase()) return 0
  if (UNINSTALL_LIKE.test(stem)) return 3
  return 1
}

/**
 * Pick a plausible entry program from a folder's top level. Uninstallers and
 * updaters are deprioritised; an executable named like its folder wins.
 */
export async function pickEntryExecutable(
  dirPath: string
): Promise<{ entryPath: string | null; warning: string | null }> {
  let names: string[] = []
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && nodePath.extname(entry.name).toLowerCase() === '.exe')
      .map((entry) => entry.name)
  } catch {
    return { entryPath: null, warning: null }
  }
  if (names.length === 0) {
    return {
      entryPath: null,
      warning: '安装目录顶层没有找到 .exe 文件，将只检查文本路径引用。'
    }
  }
  const directoryName = nodePath.basename(dirPath)
  names.sort(
    (left, right) =>
      executableScore(left, directoryName) - executableScore(right, directoryName) ||
      (left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0)
  )
  const chosen = names[0] ?? null
  if (chosen === null) return { entryPath: null, warning: null }
  const warning =
    names.length > 1
      ? `安装目录顶层有 ${names.length} 个 .exe 文件，已默认使用「${chosen}」作为入口程序。`
      : null
  return { entryPath: nodePath.join(dirPath, chosen), warning }
}

async function statPath(absPath: string): Promise<Awaited<ReturnType<typeof fsp.stat>> | null> {
  try {
    return await fsp.stat(absPath)
  } catch {
    return null
  }
}

async function directoryTarget(
  rootPath: string,
  kindHint: ParsedSoftwareTarget['kindHint'],
  platform: NodeJS.Platform
): Promise<ParsedSoftwareTarget> {
  const resolved = nodePath.resolve(rootPath)
  assertSafeSoftwareRoot(resolved, platform)
  const picked = await pickEntryExecutable(resolved)
  return {
    rootPath: resolved,
    entryPath: picked.entryPath,
    kindHint,
    warnings: picked.warning ? [picked.warning] : []
  }
}

async function executableTarget(
  exePath: string,
  kindHint: ParsedSoftwareTarget['kindHint'],
  platform: NodeJS.Platform
): Promise<ParsedSoftwareTarget> {
  const resolved = nodePath.resolve(exePath)
  const rootPath = nodePath.dirname(resolved)
  assertSafeSoftwareRoot(rootPath, platform)
  const stats = await statPath(rootPath)
  if (!stats || !stats.isDirectory()) {
    throw new SoftwareTargetError('FILE_NOT_FOUND', `找不到程序所在的文件夹：${rootPath}`)
  }
  return { rootPath, entryPath: resolved, kindHint, warnings: [] }
}

/**
 * Resolve a user-selected target to an install root + optional entry program.
 *
 * Accepts an `.exe`, an `.lnk` or a directory. Rejects drive roots, Windows
 * system directories and the user-profile root (see plan section A6), with a
 * Chinese explanation and one of the stable `SoftwareTargetErrorCode` values.
 */
export async function parseSoftwareTarget(
  absPath: string,
  options: ParseSoftwareTargetOptions = {}
): Promise<ParsedSoftwareTarget> {
  const platform = options.platform ?? process.platform
  if (typeof absPath !== 'string' || absPath.trim().length === 0) {
    throw new SoftwareTargetError('SOFTWARE_TARGET_INVALID', '没有选择要扫描的软件路径。')
  }
  const resolved = nodePath.resolve(absPath.trim())
  const stats = await statPath(resolved)
  if (!stats) {
    throw new SoftwareTargetError('FILE_NOT_FOUND', `找不到这个路径：${resolved}`)
  }

  if (stats.isDirectory()) {
    return directoryTarget(resolved, 'directory', platform)
  }
  if (!stats.isFile()) {
    throw new SoftwareTargetError('SOFTWARE_TARGET_INVALID', '只能扫描 .exe、.lnk 或软件安装目录。')
  }

  const extension = nodePath.extname(resolved).toLowerCase()
  if (extension === '.exe') {
    return executableTarget(resolved, 'exe', platform)
  }

  if (extension === '.lnk') {
    const shortcut = await parseShortcutFile(resolved)
    if (shortcut.targetPath === null) {
      throw new SoftwareTargetError(
        'SOFTWARE_TARGET_INVALID',
        `无法解析这个快捷方式的目标：${shortcut.reason || '快捷方式没有记录目标路径。'}`
      )
    }
    const rawTarget = shortcut.targetPath.trim()
    const targetAbs = nodePath.isAbsolute(rawTarget)
      ? nodePath.resolve(rawTarget)
      : nodePath.resolve(nodePath.dirname(resolved), rawTarget)
    const targetStats = await statPath(targetAbs)
    if (targetStats?.isDirectory()) {
      return directoryTarget(targetAbs, 'shortcut', platform)
    }
    if (targetStats?.isFile()) {
      if (nodePath.extname(targetAbs).toLowerCase() === '.exe') {
        return executableTarget(targetAbs, 'shortcut', platform)
      }
      // A shortcut to a script/batch launcher still identifies the software
      // folder; only the binary pass will be absent.
      const parsed = await directoryTarget(nodePath.dirname(targetAbs), 'shortcut', platform)
      parsed.warnings.push('这个快捷方式指向的不是 .exe 程序，将只检查它所在文件夹里的文本路径引用。')
      return parsed
    }
    // Target recorded but missing on disk: keep the folder when it exists so a
    // moved/broken shortcut still gives a useful “here it used to be” result.
    if (nodePath.extname(targetAbs).toLowerCase() === '.exe') {
      const parsed = await executableTarget(targetAbs, 'shortcut', platform)
      parsed.warnings.push(`快捷方式指向的程序当前不存在：${targetAbs}`)
      return parsed
    }
    throw new SoftwareTargetError('FILE_NOT_FOUND', `快捷方式指向的目标不存在：${targetAbs}`)
  }

  throw new SoftwareTargetError(
    'SOFTWARE_TARGET_INVALID',
    '只能扫描 .exe、.lnk 或软件安装目录；请选择程序文件或它所在的文件夹。'
  )
}

function resolvePowershellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir']
  if (typeof systemRoot === 'string' && systemRoot.trim().length > 0) {
    const candidate = nodePath.join(
      systemRoot.trim(),
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Fall through to PATH lookup.
    }
  }
  return 'powershell.exe'
}

function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function cleanVersionField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (trimmed.length === 0) return null
  return truncateText(trimmed, MAX_VERSION_FIELD_CHARS)
}

/**
 * Read `ProductName` / `FileDescription` / `ProductVersion` / `CompanyName` from
 * a program's Windows file version resource.
 *
 * One read-only `powershell.exe` query (`Get-Item … .VersionInfo`), 5 s timeout,
 * no window, UTF-8 output, single-quote-escaped path. Returns all-null fields on
 * any failure; never launches the selected program. Returns all-null without
 * spawning anything when the platform is not Windows.
 */
export async function readFileVersionInfo(
  absPath: string,
  options: ReadFileVersionInfoOptions = {}
): Promise<SoftwareVersionInfo> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return emptyVersionInfo()
  if (typeof absPath !== 'string' || absPath.trim().length === 0) return emptyVersionInfo()
  const resolved = nodePath.resolve(absPath.trim())
  if (resolved.length > 4096) return emptyVersionInfo()

  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(Math.floor(options.timeoutMs), 30_000)
      : VERSION_INFO_TIMEOUT_MS
  const powershellPath = options.powershellPath ?? resolvePowershellPath()
  const literal = escapePowerShellLiteral(resolved)
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    "$ErrorActionPreference='Stop';",
    `$v=(Get-Item -LiteralPath '${literal}').VersionInfo;`,
    '[pscustomobject]@{',
    'productName=$v.ProductName;',
    'fileDescription=$v.FileDescription;',
    'productVersion=$v.ProductVersion;',
    'companyName=$v.CompanyName',
    '} | ConvertTo-Json -Compress'
  ].join(' ')

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        powershellPath,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          timeout: timeoutMs,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 64 * 1024,
          ...(options.signal ? { signal: options.signal } : {})
        },
        (error, output) => {
          if (error) reject(error)
          else resolve(typeof output === 'string' ? output : String(output))
        }
      )
    })
    const parsed = JSON.parse(stdout.trim()) as unknown
    if (typeof parsed !== 'object' || parsed === null) return emptyVersionInfo()
    const record = parsed as Record<string, unknown>
    return {
      productName: cleanVersionField(record['productName']),
      fileDescription: cleanVersionField(record['fileDescription']),
      productVersion: cleanVersionField(record['productVersion']),
      companyName: cleanVersionField(record['companyName'])
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    return emptyVersionInfo()
  }
}

/**
 * Inspect a selected `.exe` / `.lnk` / directory: resolve the install root and
 * entry program, then read the version metadata (read-only). `iconDataUrl` is
 * always null here — the main process enriches it with the Electron icon cache.
 */
export async function inspectSoftware(
  absPath: string,
  options: InspectSoftwareOptions = {}
): Promise<SoftwareInspectResult> {
  const platform = options.platform ?? process.platform
  const target = await parseSoftwareTarget(
    absPath,
    options.platform === undefined ? {} : { platform: options.platform }
  )
  const warnings = [...target.warnings]
  const info: SoftwareInfo = {
    ...emptyVersionInfo(),
    entryPath: target.entryPath,
    iconDataUrl: null
  }
  if (target.entryPath !== null && nodePath.extname(target.entryPath).toLowerCase() === '.exe') {
    try {
      const version = await readFileVersionInfo(target.entryPath, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        platform,
        ...(options.powershellPath === undefined ? {} : { powershellPath: options.powershellPath })
      })
      info.productName = version.productName
      info.fileDescription = version.fileDescription
      info.productVersion = version.productVersion
      info.companyName = version.companyName
      if (
        version.productName === null &&
        version.fileDescription === null &&
        version.productVersion === null &&
        version.companyName === null
      ) {
        warnings.push(
          '没能读取到这个程序的文件版本信息（可能不是 Windows 程序，或系统繁忙），报告里会改用文件名显示。'
        )
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      warnings.push(`读取文件版本信息失败：${truncateText(errorMessage(error), 160)}`)
    }
  }
  return {
    rootPath: target.rootPath,
    entryPath: target.entryPath,
    info,
    warnings
  }
}
