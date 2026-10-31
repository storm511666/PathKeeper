/**
 * Shared helpers for the core-engine Vitest suite.
 *
 * Tests build throwaway projects under the OS temp directory, scan them with
 * the real engine, and always clean up afterwards.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  IgnoreRule,
  MatchRule,
  MatchModes,
  PathKindInput,
  RuleCategory
} from '../../src/shared/types'
import {
  BUILTIN_IGNORE_RULES,
  BUILTIN_MATCH_RULES
} from '../../src/shared/defaults'
import { scanProject, type EngineScanResult, type ScanProjectOptions } from '../../src/main/core'

const EPOCH = '2024-01-01T00:00:00.000Z'
const createdRoots: string[] = []
let ruleSequence = 1
let ignoreSequence = 1

export interface TempProject {
  root: string
  /** Write a file (creating parent directories); returns the absolute path. */
  write(relativePath: string, content: string | Buffer): Promise<string>
  /** Create a directory; returns the absolute path. */
  directory(relativePath: string): Promise<string>
  /** Absolute path for a project-relative path. */
  absolute(relativePath: string): string
}

export async function createTempProject(
  files: Record<string, string | Buffer> = {}
): Promise<TempProject> {
  const root = await mkdtemp(join(tmpdir(), 'pathkeeper-core-'))
  createdRoots.push(root)
  const project: TempProject = {
    root,
    absolute(relativePath) {
      return join(root, relativePath)
    },
    async directory(relativePath) {
      const absolutePath = join(root, relativePath)
      await mkdir(absolutePath, { recursive: true })
      return absolutePath
    },
    async write(relativePath, content) {
      const absolutePath = join(root, relativePath)
      await mkdir(dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, content)
      return absolutePath
    }
  }
  for (const [relativePath, content] of Object.entries(files)) {
    await project.write(relativePath, content)
  }
  return project
}

export async function cleanupTempProjects(): Promise<void> {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()
    if (!root) continue
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows can briefly lock files; leftovers in %TEMP% are harmless.
    }
  }
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

let matchModesDefault: MatchModes = { strict: true, basename: true, directory: true }

export function setDefaultModes(modes: MatchModes): void {
  matchModesDefault = modes
}

export function defaultModes(): MatchModes {
  return { ...matchModesDefault }
}

export interface MatchRuleSeed {
  pattern: string
  flags?: string
  ruleKey?: string
  name?: string
  category?: RuleCategory
  priority?: number
  enabled?: boolean
}

export function makeRule(seed: MatchRuleSeed): MatchRule {
  const id = ruleSequence
  ruleSequence += 1
  return {
    id,
    projectId: 1,
    ruleKey: seed.ruleKey ?? `custom-rule-${id}`,
    name: seed.name ?? `自定义规则 ${id}`,
    description: '',
    category: seed.category ?? 'text',
    pattern: seed.pattern,
    flags: seed.flags ?? '',
    enabled: seed.enabled ?? true,
    builtin: false,
    priority: seed.priority ?? 50,
    createdAt: EPOCH,
    updatedAt: EPOCH
  }
}

export interface IgnoreRuleSeed {
  pattern: string
  kind: IgnoreRule['kind']
  label?: string
  enabled?: boolean
}

export function makeIgnoreRule(seed: IgnoreRuleSeed): IgnoreRule {
  const id = ignoreSequence
  ignoreSequence += 1
  return {
    id,
    projectId: 1,
    pattern: seed.pattern,
    kind: seed.kind,
    label: seed.label ?? seed.pattern,
    enabled: seed.enabled ?? true,
    builtin: false,
    sortOrder: id,
    createdAt: EPOCH
  }
}

export function makeBuiltinMatchRules(): MatchRule[] {
  return BUILTIN_MATCH_RULES.map((definition, index) => ({
    id: index + 1,
    projectId: 1,
    ruleKey: definition.key,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    pattern: definition.pattern,
    flags: definition.flags,
    enabled: definition.enabled,
    builtin: true,
    priority: definition.priority,
    createdAt: EPOCH,
    updatedAt: EPOCH
  }))
}

export function makeBuiltinIgnoreRules(): IgnoreRule[] {
  return BUILTIN_IGNORE_RULES.map((definition, index) => ({
    id: index + 1,
    projectId: 1,
    pattern: definition.pattern,
    kind: definition.kind,
    label: definition.label,
    enabled: definition.enabled,
    builtin: true,
    sortOrder: definition.sortOrder,
    createdAt: EPOCH
  }))
}

export interface ScanOverrides {
  oldPath: string
  newPath: string
  kind?: PathKindInput
  modes?: MatchModes
  rules?: MatchRule[]
  ignoreRules?: IgnoreRule[]
  caseSensitive?: boolean
  maxFileSizeKb?: number
  budget?: { maxBytes?: number; maxDurationMs?: number }
  signal?: AbortSignal
  onProgress?: (progress: import('../../src/shared/types').ScanProgress) => void
}

export function makeScanOptions(project: TempProject, overrides: ScanOverrides): ScanProjectOptions {
  const base: ScanProjectOptions = {
    projectId: 1,
    projectName: 'Fixture 项目',
    projectRoot: project.root,
    oldPath: overrides.oldPath,
    newPath: overrides.newPath,
    kind: overrides.kind ?? 'auto',
    modes: overrides.modes ?? { strict: true, basename: true, directory: true },
    rules: overrides.rules ?? makeBuiltinMatchRules(),
    ignoreRules: overrides.ignoreRules ?? makeBuiltinIgnoreRules(),
    caseSensitive: overrides.caseSensitive ?? false,
    maxFileSizeKb: overrides.maxFileSizeKb ?? 4096
  }
  if (overrides.budget) base.budget = overrides.budget
  if (overrides.signal) base.signal = overrides.signal
  if (overrides.onProgress) base.onProgress = overrides.onProgress
  return base
}

export async function runScan(
  project: TempProject,
  overrides: ScanOverrides
): Promise<EngineScanResult> {
  return scanProject(makeScanOptions(project, overrides))
}

/** All occurrences grouped by project-relative file path. */
export function groupByFile(result: EngineScanResult): Map<string, EngineScanResult['items']> {
  const grouped = new Map<string, EngineScanResult['items']>()
  for (const item of result.items) {
    const existing = grouped.get(item.filePath)
    if (existing) existing.push(item)
    else grouped.set(item.filePath, [item])
  }
  return grouped
}
