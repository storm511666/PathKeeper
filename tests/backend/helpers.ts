import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApplyResult, Project, ScanRequest, ScanResult } from '../../src/shared/types'
import { AppError } from '../../src/main/errors'
import { PathKeeperService } from '../../src/main/services/pathkeeper-service'

export const OLD_PATH = 'assets/old/file.txt'
export const NEW_PATH = 'assets/new/file.txt'

export interface TestContext {
  workspace: string
  projectRoot: string
  service: PathKeeperService
}

export async function createTestContext(): Promise<TestContext> {
  const workspace = mkdtempSync(join(tmpdir(), 'pathkeeper-svc-'))
  const projectRoot = join(workspace, 'project')
  mkdirSync(projectRoot, { recursive: true })
  const service = new PathKeeperService(join(workspace, 'user-data'))
  await service.init()
  return { workspace, projectRoot, service }
}

export function destroyTestContext(context: TestContext): void {
  context.service.close()
  rmSync(context.workspace, { recursive: true, force: true })
}

export function projectFileAbsPath(context: TestContext, relativePath: string): string {
  return join(context.projectRoot, ...relativePath.split('/'))
}

export function writeProjectFile(
  context: TestContext,
  relativePath: string,
  content: string | Buffer
): string {
  const absolute = projectFileAbsPath(context, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

export function readProjectFile(context: TestContext, relativePath: string): string {
  return readFileSync(projectFileAbsPath(context, relativePath), 'utf8')
}

export function readProjectFileBuffer(context: TestContext, relativePath: string): Buffer {
  return readFileSync(projectFileAbsPath(context, relativePath))
}

export function backupRootPath(context: TestContext): string {
  return join(context.projectRoot, '.pathkeeper-backup')
}

export function addProject(context: TestContext): Project {
  return context.service.addProjectFromPath(context.projectRoot)
}

export function scanFixture(
  context: TestContext,
  project: Project,
  overrides: Partial<ScanRequest> = {}
): Promise<ScanResult> {
  return context.service.scan({
    projectId: project.id,
    oldPath: OLD_PATH,
    newPath: NEW_PATH,
    kind: 'file',
    ...overrides
  })
}

export function occurrencesOfFile(result: ScanResult, filePath: string): ScanResult['items'] {
  const wanted = filePath.replace(/\\/g, '/')
  return result.items.filter((item) => item.filePath.replace(/\\/g, '/') === wanted)
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function captureAppError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('预期的 AppError 没有被抛出。')
}

export async function captureAppErrorAsync(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('预期的 AppError 没有被抛出。')
}

export async function applyAll(
  context: TestContext,
  project: Project
): Promise<{ scan: ScanResult; result: ApplyResult }> {
  const scan = await scanFixture(context, project)
  if (scan.items.length === 0) {
    throw new Error('测试夹具中没有可应用的扫描结果。')
  }
  const result = await context.service.apply({
    scanToken: scan.scanToken,
    occurrenceIds: scan.items.map((item) => item.id)
  })
  return { scan, result }
}
