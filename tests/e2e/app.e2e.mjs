/**
 * PathKeeper end-to-end verification.
 *
 * Launches the built Electron app with an isolated userData profile, adds a
 * disposable copy of examples/demo-project, performs a real scan + apply +
 * rollback through the UI, checks the files and backup on disk, captures the
 * screenshots used in README/docs, and prints a JSON report.
 *
 * Run: npm run build && npm run test:e2e
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots')
const DEMO_SOURCE = join(ROOT, 'examples', 'demo-project')
const OLD_PATH = 'assets/textures/old_brick_wall.png'
const NEW_PATH = 'assets/materials/brick_wall.png'
const report = { steps: [], screenshots: [], counts: {} }

function step(name, detail = '') {
  const entry = { name, detail, at: new Date().toISOString() }
  report.steps.push(entry)
  console.log(`[e2e] ${name}${detail ? ` — ${detail}` : ''}`)
}

function makeTempRoot() {
  // Prefer a neutral Windows path for screenshots (no user-profile segment),
  // and fall back to the OS temp directory on locked-down machines.
  if (process.platform === 'win32') {
    try {
      return mkdtempSync('C:\\PathKeeperDemo-')
    } catch {
      // no permission for the drive root; use the temp directory below
    }
  }
  return mkdtempSync(join(tmpdir(), 'pathkeeper-e2e-'))
}

async function dismissToasts(page) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const closers = page.getByTestId('toast-close')
    const count = await closers.count()
    if (count === 0) return
    try {
      await closers.first().click({ timeout: 1500 })
    } catch {
      return
    }
    await page.waitForTimeout(80)
  }
}

/**
 * Close the first-run onboarding dialog when it is actually visible. The
 * dialog can stay in the DOM after a reload (hidden), so `count()` alone is
 * not a reliable signal.
 */
async function closeGuideIfOpen(page) {
  const closer = page.locator('[data-testid="onboarding-dialog"] .modal-close')
  try {
    if (await closer.isVisible({ timeout: 1500 })) {
      await closer.click({ timeout: 3000 })
      await page.waitForTimeout(150)
    }
  } catch {
    // A closing animation race must never fail the run.
  }
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const tempRoot = makeTempRoot()
  const projectDir = join(tempRoot, 'demo-project')
  const profileDir = join(tempRoot, 'profile')
  cpSync(DEMO_SOURCE, projectDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })

  let electronApp = null
  let page = null
  const consoleErrors = []

  try {
    step('launching Electron', ROOT)
    const launchEnv = {
      ...process.env,
      PATHKEEPER_E2E: '1',
      PATHKEEPER_USER_DATA: profileDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
    // This agent/CI environment may run under ELECTRON_RUN_AS_NODE, which
    // turns Electron into plain Node and prevents the app window from starting.
    delete launchEnv.ELECTRON_RUN_AS_NODE
    const packagedExecutable = process.env.PATHKEEPER_E2E_EXECUTABLE
    electronApp = await electron.launch({
      ...(packagedExecutable
        ? { executablePath: resolve(packagedExecutable), args: [], cwd: ROOT }
        : { args: [ROOT], cwd: ROOT }),
      env: launchEnv,
      timeout: 90_000
    })
    page = await electronApp.firstWindow({ timeout: 60_000 })
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(String(error)))
    await page.waitForLoadState('domcontentloaded')
    // The preload bridge resolves IpcResponse envelopes (so structured error
    // codes survive the contextBridge); this helper unwraps them in page code.
    await page.addInitScript(() => {
      window.__pkUnwrap = (response) => {
        if (!response || typeof response !== 'object' || !('ok' in response)) {
          throw new Error('unexpected bridge response')
        }
        if (response.ok) return response.data
        const error = new Error((response.error && response.error.message) || 'bridge error')
        error.code = response.error && response.error.code
        error.details = response.error && response.error.details
        throw error
      }
    })
    // Init scripts apply to the next document; reload once so page code can
    // already use window.__pkUnwrap.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.pathkeeper), null, { timeout: 30_000 })
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
    step('app shell ready', await page.title())

    // Security invariants: no Node surface in the renderer and no web access.
    const security = await page.evaluate(async () => {
      let network = 'allowed'
      try {
        await fetch('https://example.com/pathkeeper-network-check', { cache: 'no-store' })
      } catch {
        network = 'blocked'
      }
      return {
        network,
        requireType: typeof window.require,
        processType: typeof window.process,
        bridge: typeof window.pathkeeper
      }
    })
    assert.equal(security.network, 'blocked', 'renderer network access must be blocked')
    assert.equal(security.requireType, 'undefined', 'window.require must not be exposed')
    assert.equal(security.processType, 'undefined', 'window.process must not be exposed')
    assert.equal(security.bridge, 'object', 'preload bridge missing')
    // The intentional probe above produces expected CSP console errors; remove
    // exactly those from the error collection we assert on at the end.
    for (let index = consoleErrors.length - 1; index >= 0; index -= 1) {
      if (consoleErrors[index]?.includes('pathkeeper-network-check')) {
        consoleErrors.splice(index, 1)
      }
    }
    step('security invariants verified', 'no network, no Node surface')

    // The folder picker is a native OS dialog; seed the project through the
    // exact same preload API and reload to let the normal startup restore it.
    const project = await page.evaluate(
      async (root) => window.__pkUnwrap(await window.pathkeeper.projects.addFromPath(root)),
      projectDir
    )
    report.counts.projectId = project.id
    step('project added', `${project.name} (${project.rootPath})`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
    await closeGuideIfOpen(page)

    // --- 2.1 beginner readability: load the bundled sample project and verify
    // the humanized missing-file card keeps the original path reachable and
    // shows a candidate thumbnail (data URL from the read-only preview IPC).
    const sampleProject = await page.evaluate(async () =>
      window.__pkUnwrap(await window.pathkeeper.projects.loadSample())
    )
    report.counts.sampleProjectId = sampleProject.id
    step('sample project loaded', `${sampleProject.name}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
    await closeGuideIfOpen(page)
    await page.waitForSelector('[data-testid="dependency-issue"]', { timeout: 120_000 })
    const humanTitle = page.getByTestId('dependency-human-title').first()
    await humanTitle.waitFor({ state: 'visible', timeout: 30_000 })
    const humanTitleText = (await humanTitle.innerText()).replace(/\s+/g, ' ')
    assert.ok(
      humanTitleText.includes('砖墙贴图（旧）'),
      `humanized title should explain old_brick_wall.png, got: ${humanTitleText}`
    )
    const thumb = page.getByTestId('dependency-candidate-thumb').first()
    await thumb.waitFor({ state: 'visible', timeout: 30_000 })
    const thumbSrc = await thumb.getAttribute('src')
    assert.ok(thumbSrc?.startsWith('data:image/'), 'candidate thumbnail should be a data URL')
    assert.ok(
      (await page.getByTestId('dependency-original-path').count()) >= 1,
      'original raw path must stay reachable in the technical details'
    )
    assert.ok(
      (await page.locator('body').innerText()).includes('为什么推荐'),
      'candidate rows should explain why they are recommended'
    )
    step('beginner readability verified', humanTitleText)
    await dismissToasts(page)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'beginner-check.png') })
    report.screenshots.push('docs/screenshots/beginner-check.png')

    // Restore the demo project as the active project for the migration flow.
    await page.evaluate(
      async ({ demoId }) =>
        window.__pkUnwrap(await window.pathkeeper.settings.update({ lastProjectId: demoId })),
      { demoId: project.id }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
    await closeGuideIfOpen(page)

    const advancedToggle = page.getByRole('complementary').getByTestId('toggle-advanced-mode')
    if (await advancedToggle.count()) {
      const checked = await advancedToggle.getAttribute('aria-checked')
      if (checked !== 'true') await advancedToggle.click()
    }
    await page.getByTestId('nav-migrate').click()
    await page.waitForSelector('[data-testid="old-path-input"]', { timeout: 30_000 })

    await page.getByTestId('old-path-input').fill(OLD_PATH)
    await page.getByTestId('new-path-input').fill(NEW_PATH)
    await page.waitForTimeout(500)

    const previewText = await page.locator('body').innerText()
    assert.ok(
      previewText.includes('assets/materials/brick_wall.png'),
      'normalized new path should be shown before scanning'
    )
    step('migration form filled', `${OLD_PATH} -> ${NEW_PATH}`)

    // Hero screenshot: the route composer before anything is scanned/written.
    await page.evaluate(() => {
      const main = document.getElementById('main-content')
      if (main) main.scrollTo({ top: 0 })
    })
    await page.waitForTimeout(250)
    await dismissToasts(page)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'main.png') })
    report.screenshots.push('docs/screenshots/main.png')

    await page.getByTestId('scan-button').click()
    await page.waitForSelector('[data-testid="result-row"]', { timeout: 120_000 })
    await page.waitForTimeout(600)
    const rows = page.locator('[data-testid="result-row"]')
    const initialCount = await rows.count()
    report.counts.matches = initialCount
    assert.ok(initialCount >= 6, `expected at least 6 matches, got ${initialCount}`)

    const allText = await page.locator('body').innerText()
    assert.ok(!allText.includes('node_modules/demo-dependency'), 'ignored dependency must not appear')
    assert.ok(!allText.includes('dist/bundle.js'), 'ignored dist file must not appear')
    step('scan result', `${initialCount} matches, ignored directories excluded`)

    // The UI may default-check rows; select all explicitly for a deterministic run.
    const selectAll = page.getByTestId('select-all')
    if (await selectAll.count()) {
      const checked = await page.locator('[data-testid="result-checkbox"]:checked').count()
      if (checked < initialCount) await selectAll.click()
    }
    await page.waitForTimeout(400)
    await dismissToasts(page)
    await page.getByTestId('result-row').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(350)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'results.png') })
    report.screenshots.push('docs/screenshots/results.png')
    step('screenshot scan results captured')

    await page.getByTestId('apply-button').click()
    await page.getByTestId('confirm-apply').waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(280)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'apply-confirm.png') })
    report.screenshots.push('docs/screenshots/apply-confirm.png')
    await page.getByTestId('confirm-apply').click()
    await page.waitForSelector('[data-testid="apply-success"]', { timeout: 120_000 })
    const successText = await page.getByTestId('apply-success').innerText()
    step('apply completed', successText.replace(/\s+/g, ' ').slice(0, 180))
    await dismissToasts(page)
    await page.getByTestId('apply-success').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'apply-success.png') })
    report.screenshots.push('docs/screenshots/apply-success.png')

    // Verify on disk: selected path spans changed, ignored copies unchanged,
    // backup directory + manifest exist.
    const preprocessPath = join(projectDir, 'scripts', 'preprocess.py')
    const preprocess = readFileSync(preprocessPath, 'utf8')
    assert.ok(!preprocess.includes(OLD_PATH), 'python reference should be updated')
    assert.ok(preprocess.includes('assets/materials/brick_wall.png'), 'new path missing from python file')
    const readme = readFileSync(join(projectDir, 'README.md'), 'utf8')
    assert.ok(!readme.includes(OLD_PATH), 'markdown reference should be updated')
    assert.ok(readme.includes(NEW_PATH), 'markdown should contain new path')
    assert.ok(
      readFileSync(join(projectDir, 'notes', 'field-notes.txt'), 'utf8').includes('assets/materials/brick_wall.png'),
      'plain-text path should be updated'
    )
    assert.ok(
      readFileSync(join(projectDir, 'node_modules', 'demo-dependency', 'README.md'), 'utf8').includes(OLD_PATH),
      'ignored node_modules fixture must be untouched'
    )
    assert.ok(
      readFileSync(join(projectDir, 'dist', 'bundle.js'), 'utf8').includes(OLD_PATH),
      'ignored dist fixture must be untouched'
    )
    const backupRoot = join(projectDir, '.pathkeeper-backup')
    assert.ok(existsSync(backupRoot), 'backup directory missing')
    const backupIds = readdirSync(backupRoot)
    assert.ok(backupIds.length >= 1, 'no timestamped backup folder')
    const backupDir = join(backupRoot, backupIds[0])
    assert.ok(existsSync(join(backupDir, 'manifest.json')), 'backup manifest missing')
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    report.counts.backupFiles = manifest.files?.length ?? manifest.filesCount ?? null
    report.counts.backupDir = backupDir
    step('disk + backup verified', `${backupIds[0]}`)

    // History page + rollback.
    await page.getByTestId('nav-history').click()
    await page.waitForSelector('[data-testid="history-row"]', { timeout: 30_000 })
    await dismissToasts(page)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'history.png') })
    report.screenshots.push('docs/screenshots/history.png')
    step('history page captured')

    await page.getByTestId('history-row').first().getByTestId('rollback-button').click()
    await page.waitForSelector('[data-testid="confirm-dialog"]', { timeout: 10_000 })
    await page.getByTestId('confirm-rollback').click()
    await page.waitForSelector('[data-testid="rollback-success"]', { timeout: 120_000 })
    const restored = readFileSync(preprocessPath, 'utf8')
    assert.ok(restored.includes('old_brick_wall.png'), 'rollback did not restore the original file')
    assert.ok(!restored.includes('assets/materials/brick_wall.png'), 'rollback left new path behind')
    step('rollback verified on disk')

    // Settings screens (rules editor + backup management).
    await page.getByTestId('nav-settings').click()
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30_000 })
    await dismissToasts(page)
    const rulesTab = page.getByTestId('tab-rules')
    if (await rulesTab.count()) await rulesTab.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'settings-rules.png') })
    report.screenshots.push('docs/screenshots/settings-rules.png')
    const backupsTab = page.getByTestId('tab-backups')
    if (await backupsTab.count()) await backupsTab.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'settings-backups.png') })
    report.screenshots.push('docs/screenshots/settings-backups.png')
    step('settings pages captured')

    // Directory migration uses the same engine through the preload API.
    const directoryScan = await page.evaluate(async (demoRoot) => {
      const projects = window.__pkUnwrap(await window.pathkeeper.projects.list())
      // The beginner sample was opened earlier in this run; pick the demo
      // project by root instead of relying on list ordering.
      const active = projects.find(
        (project) => project.rootPath.toLowerCase() === demoRoot.toLowerCase()
      )
      if (!active) throw new Error('demo project missing from the project list')
      return window.__pkUnwrap(
        await window.pathkeeper.scan({
          projectId: active.id,
          oldPath: 'datasets/raw',
          newPath: 'datasets/processed',
          kind: 'directory'
        })
      )
    }, projectDir)
    report.counts.directoryMatches = directoryScan.items.length
    assert.equal(directoryScan.pathInfo.kind, 'directory')
    assert.ok(directoryScan.items.length >= 1, 'directory migration should find dataset references')
    assert.ok(
      directoryScan.items.some((item) => item.filePath === 'configs/dataset.json'),
      'directory scan should include dataset config'
    )
    step('directory matching verified', `${directoryScan.items.length} references`)

    // --- 2.1: 1 GB single-file ceiling round-trip through the real IPC. -----
    const sizeRoundTrip = await page.evaluate(async () => {
      const api = window.pathkeeper
      const unwrap = window.__pkUnwrap
      const accepted = unwrap(await api.settings.update({ maxFileSizeKb: 1048576 }))
      let rejectedCode = null
      try {
        unwrap(await api.settings.update({ maxFileSizeKb: 1048577 }))
      } catch (error) {
        rejectedCode = error && error.code ? error.code : 'UNKNOWN'
      }
      const persisted = unwrap(await api.settings.get())
      return { accepted: accepted.maxFileSizeKb, persisted: persisted.maxFileSizeKb, rejectedCode }
    })
    assert.equal(sizeRoundTrip.accepted, 1048576, '1 GB must be accepted')
    assert.equal(sizeRoundTrip.persisted, 1048576, '1 GB must persist after save + read')
    assert.equal(sizeRoundTrip.rejectedCode, 'SETTINGS_INVALID', '1 GB + 1 KB must be rejected')
    step('1 GB settings verified', '1048576 accepted, 1048577 rejected')

    // --- 2.1: software scan (read-only). A disposable copy of the demo
    // project stands in for an install folder; a real system exe is copied in
    // so PE import analysis has something to parse (it is never executed). -
    const softwareDir = join(tempRoot, 'demo-software')
    cpSync(DEMO_SOURCE, softwareDir, { recursive: true })
    const systemExeSource = 'C:\\Windows\\System32\\notepad.exe'
    const hasSystemExe = existsSync(systemExeSource)
    if (hasSystemExe) cpSync(systemExeSource, join(softwareDir, 'notepad.exe'))
    const software = await page.evaluate(
      async ({ root, includeBinary }) => {
        const api = window.pathkeeper
        const unwrap = window.__pkUnwrap
        const added = unwrap(await api.software.add({ rootPath: root, entryPath: null }))
        const scan = unwrap(await api.software.scan({ projectId: added.id, includeBinary }))
        return { added, scan }
      },
      { root: softwareDir, includeBinary: hasSystemExe }
    )
    report.counts.softwareProjectId = software.added.id
    report.counts.softwareDlls = software.scan.binaryDependencies?.length ?? 0
    report.counts.softwareIssues = software.scan.textReport?.issues?.length ?? 0
    report.counts.softwareScope = software.scan.textScanScope
    assert.equal(software.added.kind, 'software', 'software project kind')
    assert.equal(
      software.added.rootPath.toLowerCase(),
      softwareDir.toLowerCase(),
      'software install root'
    )
    assert.ok(software.scan.textReport, 'software scan must include a text-reference report')
    // 2.1.1: installed software defaults to the low-noise config-only text scan.
    assert.equal(software.scan.textScanScope, 'config', 'default text scan scope must be config')
    assert.equal(
      typeof software.scan.textIssuesSkipped,
      'number',
      'skipped-reference count must be reported'
    )
    assert.ok(
      (software.scan.textReport?.issues?.length ?? 0) <= 80,
      'software text issues must stay bounded'
    )
    assert.ok(
      !('error' in software.scan),
      `software scan must not fail: ${JSON.stringify(software.scan.warnings ?? [])}`
    )
    if (hasSystemExe) {
      assert.equal(software.scan.binaryAnalysis, 'analyzed', 'binary analysis should run')
      assert.ok(
        software.scan.binaryFilesScanned.includes('notepad.exe'),
        `entry exe should be parsed, got: ${software.scan.binaryFilesScanned.join(',')}`
      )
      assert.ok(software.scan.binaryDependencies.length > 0, 'imported DLLs should be detected')
    }
    step(
      'software scan verified',
      `${report.counts.softwareDlls} DLLs, ${report.counts.softwareIssues} path issues`
    )

    // Software report page + screenshot: the app must land on the software
    // page automatically when the active project kind is 'software'.
    await page.evaluate(
      async ({ softwareId }) =>
        window.__pkUnwrap(await window.pathkeeper.settings.update({ lastProjectId: softwareId })),
      { softwareId: software.added.id }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
    await closeGuideIfOpen(page)
    await page.waitForSelector('[data-testid="software-page"]', { timeout: 30_000 })
    // Opening a software project auto-runs the report; only trigger a manual
    // run if the report never appears, and then wait for the rescan to settle
    // before taking the screenshot.
    const softwareReport = page.locator('[data-testid="software-report"]')
    try {
      await softwareReport.waitFor({ state: 'visible', timeout: 60_000 })
    } catch {
      const rescan = page.getByTestId('software-rescan')
      if (await rescan.count()) await rescan.click()
      await softwareReport.waitFor({ state: 'visible', timeout: 120_000 })
    }
    const rescanning = page.locator('[data-testid="software-rescanning"]')
    if ((await rescanning.count()) > 0) {
      await rescanning.waitFor({ state: 'detached', timeout: 90_000 }).catch(() => undefined)
    }
    await page.waitForTimeout(350)
    const softwareText = (await page.getByTestId('software-report').innerText()).replace(
      /\s+/g,
      ' '
    )
    assert.ok(
      softwareText.includes('依赖') || softwareText.includes('缺少'),
      `software report should list dependencies, got: ${softwareText.slice(0, 200)}`
    )
    assert.ok(
      softwareText.includes('无法判断') || (await page.getByTestId('software-limitations').count()) > 0,
      'software report must state the static-check limitations'
    )

    // 2.1.2: every path issue answers 它是什么 / 它有什么用 / 不处理会怎样.
    if (report.counts.softwareIssues > 0) {
      assert.ok(softwareText.includes('它是什么'), 'path issues must answer “它是什么”')
      assert.ok(softwareText.includes('有什么用'), 'path issues must answer “它有什么用”')
      assert.ok(
        softwareText.includes('不处理') || softwareText.includes('如果不管'),
        'path issues must explain what happens if ignored'
      )
      const pathSection = page.getByTestId('software-text-issues')
      if ((await pathSection.count()) > 0) {
        await pathSection.scrollIntoViewIfNeeded()
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(SCREENSHOT_DIR, 'software-path-help.png') })
        report.screenshots.push('docs/screenshots/software-path-help.png')
      }
    }

    // 2.1.1: the report exposes the text-scan scope and can switch it.
    const scopeSelect = page.locator('[data-testid="software-text-scope-select"]')
    if (await scopeSelect.count()) {
      assert.equal(await scopeSelect.inputValue(), 'config', 'scope selector defaults to config')
      await dismissToasts(page)
      // The path-help screenshot above scrolled the page; reset to the top so
      // the README hero shot shows the report summary.
      await page.evaluate(() => {
        const main = document.getElementById('main-content')
        if (main) main.scrollTo({ top: 0 })
      })
      await page.waitForTimeout(350)
      await page.screenshot({ path: join(SCREENSHOT_DIR, 'software-scan.png') })
      report.screenshots.push('docs/screenshots/software-scan.png')
      step('software report page captured')

      // Switching to “不检查” re-scans and hides the text-path section honestly.
      await scopeSelect.selectOption('off')
      const rescanBanner = page.locator('[data-testid="software-rescanning"]')
      if ((await rescanBanner.count()) > 0) {
        await rescanBanner.waitFor({ state: 'detached', timeout: 90_000 }).catch(() => undefined)
      }
      await page.waitForTimeout(400)
      const offText = (await page.getByTestId('software-report').innerText()).replace(/\s+/g, ' ')
      assert.ok(
        offText.includes('没有执行') || offText.includes('不检查') || offText.includes('未检查'),
        `scope=off should state the text check was skipped, got: ${offText.slice(0, 160)}`
      )
      await scopeSelect.selectOption('config')
      if ((await rescanBanner.count()) > 0) {
        await rescanBanner.waitFor({ state: 'detached', timeout: 90_000 }).catch(() => undefined)
      }
      step('software text-scan scope switch verified')
    } else {
      await dismissToasts(page)
      await page.screenshot({ path: join(SCREENSHOT_DIR, 'software-scan.png') })
      report.screenshots.push('docs/screenshots/software-scan.png')
      step('software report page captured')
    }

    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join('\n')}`)
    report.result = 'passed'
    writeFileSync(join(tempRoot, 'report.json'), JSON.stringify(report, null, 2))
    console.log('\n=== PATHKEEPER E2E PASSED ===')
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    report.result = 'failed'
    report.error = error instanceof Error ? error.stack : String(error)
    console.error('\n=== PATHKEEPER E2E FAILED ===')
    console.error(report.error)
    if (page) {
      try {
        await page.screenshot({ path: join(SCREENSHOT_DIR, 'e2e-failure.png') })
      } catch {
        // ignore screenshot failure
      }
    }
    process.exitCode = 1
  } finally {
    if (electronApp) {
      try {
        await electronApp.close()
      } catch {
        // ignore close failure
      }
    }
    // Keep screenshots but remove the disposable project/profile.
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore cleanup failure
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
