import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import { PathKeeperService } from '../../src/main/services/pathkeeper-service'

const mocks = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >()
  const dialogState = {
    openFiles: [] as string[][],
    saveFile: null as string | null
  }
  return { handlers, dialogState }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0-test' },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      mocks.handlers.delete(channel)
    }
  },
  dialog: {
    showOpenDialog: async () => ({
      canceled: mocks.dialogState.openFiles.length === 0,
      filePaths: mocks.dialogState.openFiles.shift() ?? []
    }),
    showSaveDialog: async () => ({
      canceled: mocks.dialogState.saveFile === null,
      filePath: mocks.dialogState.saveFile ?? undefined
    })
  },
  shell: {
    openPath: async () => '',
    showItemInFolder: () => undefined
  }
}))

// Imported after vi.mock so the electron module is the mock above.
// eslint-disable-next-line import/first
import { registerIpcHandlers } from '../../src/main/ipc'

interface IpcEnvelope {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; details?: unknown }
}

type Handler = (event: unknown, ...args: unknown[]) => Promise<IpcEnvelope>

const OLD_PATH = 'assets/old/file.txt'
const NEW_PATH = 'assets/new/file.txt'

let workspace: string
let projectRoot: string
let service: PathKeeperService
let sent: Array<{ channel: string; payload: unknown }>

const fakeEvent = {
  sender: {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload })
    }
  }
}

function handlerFor(channel: string): Handler {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`IPC channel ${channel} is not registered`)
  return handler as Handler
}

async function invoke(channel: string, ...args: unknown[]): Promise<IpcEnvelope> {
  return handlerFor(channel)(fakeEvent, ...args)
}

function writeProjectFile(relativePath: string, content: string): void {
  const absolute = join(projectRoot, ...relativePath.split('/'))
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'pathkeeper-ipc-'))
  projectRoot = join(workspace, 'project')
  mkdirSync(projectRoot, { recursive: true })
  service = new PathKeeperService(join(workspace, 'user-data'))
  await service.init()
  mocks.handlers.clear()
  mocks.dialogState.openFiles = []
  mocks.dialogState.saveFile = null
  sent = []
  registerIpcHandlers(service, () => null)
})

afterEach(() => {
  service.close()
  rmSync(workspace, { recursive: true, force: true })
})

describe('ipc registration', () => {
  it('registers exactly every request channel declared in src/shared/ipc.ts', () => {
    // scan:progress and dependencies:changed are pushed event channels.
    const expected = Object.values(IPC)
      .filter((channel) => channel !== IPC.scanProgress && channel !== IPC.dependenciesChanged)
      .sort()
    const registered = [...mocks.handlers.keys()].sort()
    expect(registered).toEqual(expected)
    expect(new Set(registered).size).toBe(expected.length)
  })
})

describe('ipc envelope', () => {
  it('wraps success and error responses in the IpcResponse envelope', async () => {
    const added = await invoke(IPC.projectsAddFromPath, projectRoot)
    expect(added.ok).toBe(true)
    const project = added.data as { id: number; lastOpenedAt: string | null }
    expect(project.id).toBeGreaterThan(0)
    expect(project.lastOpenedAt).toBeTruthy()

    const listed = await invoke(IPC.projectsList)
    expect(listed.ok).toBe(true)
    expect(listed.data).toHaveLength(1)

    const renamed = await invoke(IPC.projectsRename, project.id, '  renamed  ')
    expect((renamed.data as { name: string }).name).toBe('renamed')

    const failed = await invoke(IPC.projectsRename, 9999, 'x')
    expect(failed.ok).toBe(false)
    expect(failed.error?.code).toBe('PROJECT_NOT_FOUND')
    expect(typeof failed.error?.message).toBe('string')
  })

  it('serves settings, rules and ignores channels', async () => {
    const project = (await invoke(IPC.projectsAddFromPath, projectRoot)).data as { id: number }
    const settings = await invoke(IPC.settingsUpdate, {
      matchModes: { strict: true, basename: true, directory: false },
      maxFileSizeKb: 2048
    })
    expect(settings.ok).toBe(true)
    expect((settings.data as { maxFileSizeKb: number }).maxFileSizeKb).toBe(2048)

    const rules = await invoke(IPC.rulesList, project.id)
    expect((rules.data as unknown[]).length).toBeGreaterThan(0)
    const custom = await invoke(IPC.rulesAdd, project.id, {
      name: 'ipc rule',
      description: '',
      category: 'custom',
      pattern: '"(?<path>[^"]+)"',
      flags: '',
      enabled: true
    })
    expect(custom.ok).toBe(true)
    const ruleId = (custom.data as { id: number }).id
    expect((await invoke(IPC.rulesUpdate, ruleId, { enabled: false })).ok).toBe(true)
    expect((await invoke(IPC.rulesRemove, ruleId)).ok).toBe(true)
    expect((await invoke(IPC.rulesValidate, '([bad', '')).data).toMatchObject({ valid: false })
    expect(
      (await invoke(IPC.rulesTest, '"(?<path>[^"]+)"', '', 'x "a/b.txt"')).data
    ).toMatchObject({ matchCount: 1 })
    expect((await invoke(IPC.rulesReset, project.id)).ok).toBe(true)

    const ignores = await invoke(IPC.ignoresList, project.id)
    expect((ignores.data as unknown[]).length).toBeGreaterThan(0)
    const ignore = await invoke(IPC.ignoresAdd, project.id, { pattern: 'log', kind: 'suffix' })
    expect((ignore.data as { pattern: string }).pattern).toBe('.log')
    expect((await invoke(IPC.ignoresUpdate, (ignore.data as { id: number }).id, { enabled: false })).ok).toBe(true)
    expect((await invoke(IPC.ignoresRemove, (ignore.data as { id: number }).id)).ok).toBe(true)
    expect((await invoke(IPC.ignoresReset, project.id)).ok).toBe(true)
  })

  it('runs scan, streams progress and applies through the channel envelope', async () => {
    writeProjectFile('notes/readme.txt', `Move ${OLD_PATH} now.\n`)
    const project = (await invoke(IPC.projectsAddFromPath, projectRoot)).data as { id: number }

    const scanResponse = await invoke(IPC.scanRun, {
      projectId: project.id,
      oldPath: OLD_PATH,
      newPath: NEW_PATH,
      kind: 'file'
    })
    expect(scanResponse.ok).toBe(true)
    const scan = scanResponse.data as {
      scanToken: string
      items: Array<{ id: string }>
      projectRoot: string
    }
    expect(scan.items.length).toBeGreaterThan(0)
    expect(scan.items[0]?.id).toBeTruthy()
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((event) => event.channel === IPC.scanProgress)).toBe(true)
    expect((sent[0]?.payload as { phase: string }).phase).toBe('preparing')

    const applyResponse = await invoke(IPC.applyRun, {
      scanToken: scan.scanToken,
      occurrenceIds: scan.items.map((item) => item.id)
    })
    expect(applyResponse.ok).toBe(true)
    const applied = applyResponse.data as { migrationId: number; filesChanged: number }
    expect(applied.filesChanged).toBe(1)

    const history = await invoke(IPC.historyList, project.id)
    expect((history.data as unknown[]).length).toBe(1)
    const rollback = await invoke(IPC.historyRollback, applied.migrationId)
    expect(rollback.ok).toBe(true)
    expect((rollback.data as { filesRestored: number }).filesRestored).toBe(1)
    expect((await invoke(IPC.historyRemove, applied.migrationId)).ok).toBe(true)
  })

  it('answers system info and constrains native file picking to the project root', async () => {
    const project = (await invoke(IPC.projectsAddFromPath, projectRoot)).data as { id: number }
    writeProjectFile('docs/a.md', '# hello')

    const info = await invoke(IPC.systemInfo)
    expect(info.ok).toBe(true)
    const systemInfo = info.data as Record<string, string>
    expect(systemInfo.userDataPath).toBe(service.getUserDataPath())
    expect(systemInfo.nodeVersion).toBe(process.versions.node)
    expect(systemInfo.platform).toBe(process.platform)

    // A pick outside the project root must be rejected.
    mocks.dialogState.openFiles = [[join(workspace, 'outside.txt')]]
    const outside = await invoke(IPC.pickProjectPath, {
      projectId: project.id,
      side: 'old',
      kind: 'file'
    })
    expect(outside.ok).toBe(false)
    expect(outside.error?.code).toBe('PATH_OUTSIDE_PROJECT')

    // A pick inside the project root comes back project-relative.
    mocks.dialogState.openFiles = [[join(projectRoot, 'docs', 'a.md')]]
    const inside = await invoke(IPC.pickProjectPath, {
      projectId: project.id,
      side: 'old',
      kind: 'file'
    })
    expect(inside.ok, JSON.stringify(inside.error)).toBe(true)
    expect((inside.data as { relPath: string }).relPath).toBe('docs/a.md')

    // showProjectFile rejects traversal but accepts real files.
    const traversal = await invoke(IPC.systemShowProjectFile, project.id, '../../secret.txt')
    expect(traversal.ok).toBe(false)
    const shown = await invoke(IPC.systemShowProjectFile, project.id, 'docs/a.md')
    expect(shown.ok).toBe(true)

    const added = await invoke(IPC.projectsAdd)
    expect(added.ok).toBe(true)
    expect(added.data).toBeNull()
    expect((await invoke(IPC.projectsReveal, project.id)).ok).toBe(true)
  })

  it('writes exported CSV through the save dialog with a UTF-8 BOM', async () => {
    const outputFile = join(workspace, 'export.csv')
    mocks.dialogState.saveFile = outputFile
    const response = await invoke(IPC.saveTextFile, {
      defaultName: 'export.csv',
      content: 'file,line\r\nnotes/readme.txt,2\r\n'
    })
    expect(response.ok).toBe(true)
    expect(response.data).toBe(outputFile)
    expect(existsSync(outputFile)).toBe(true)
    const bytes = readFileSync(outputFile)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toContain('notes/readme.txt')

    mocks.dialogState.saveFile = null
    const canceled = await invoke(IPC.saveTextFile, { defaultName: 'x.csv', content: 'a' })
    expect(canceled.data).toBeNull()
  })
})
