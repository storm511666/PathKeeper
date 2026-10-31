/**
 * PathKeeper shared data contracts.
 *
 * These types cross the Electron context bridge, so they must stay
 * JSON-serializable. Main-process-only structures live beside their
 * implementation under src/main.
 */

/** Whether a migration moves a single file or a whole directory. */
export type PathKind = 'file' | 'directory'

/** The user may let PathKeeper infer file vs. directory. */
export type PathKindInput = PathKind | 'auto'

/**
 * strict   — the full normalized project-relative path must match
 * basename — the file name must match (path is normalized and inspected)
 * directory— every reference below a moved directory is remapped
 */
export type MatchMode = 'strict' | 'basename' | 'directory'

export interface MatchModes {
  strict: boolean
  basename: boolean
  directory: boolean
}

export type RuleCategory =
  | 'markdown'
  | 'code'
  | 'config'
  | 'web'
  | 'workflow'
  | 'text'
  | 'custom'

export type IgnoreKind = 'dir' | 'suffix' | 'glob'

export type MigrationStatus = 'pending' | 'applied' | 'rolled_back' | 'failed'

/** Encoding detected by the scanner and preserved by the writer. */
export type FileEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be'

/**
 * `project` — a normal source/config project (default).
 * `software` — an installed program opened through “扫描一个软件”. The scan is
 * read-only and additionally inspects the program's binary dependencies.
 */
export type ProjectKind = 'project' | 'software'

export interface Project {
  id: number
  name: string
  rootPath: string
  /** Selected `.exe` entry point for software projects; null otherwise. */
  entryPath: string | null
  kind: ProjectKind
  createdAt: string
  lastOpenedAt: string | null
}

export interface MatchRule {
  id: number
  projectId: number
  /** Stable identifier for built-in rules; custom rules use a generated key. */
  ruleKey: string
  name: string
  description: string
  category: RuleCategory
  /** JavaScript regular expression source. Must expose a `path` named group or one capture group. */
  pattern: string
  /** Base flags without `g`/`d`; the engine adds those itself. */
  flags: string
  enabled: boolean
  builtin: boolean
  priority: number
  createdAt: string
  updatedAt: string
}

export interface IgnoreRule {
  id: number
  projectId: number
  /** Directory name for `dir`, extension for `suffix` (e.g. ".exe"), or glob for `glob`. */
  pattern: string
  kind: IgnoreKind
  label: string
  enabled: boolean
  builtin: boolean
  sortOrder: number
  createdAt: string
}

export interface AppSettings {
  lastProjectId: number | null
  matchModes: MatchModes
  caseSensitive: boolean
  /** Files larger than this are skipped instead of loaded into memory. */
  maxFileSizeKb: number
  /** Show the simplified beginner workspace; advanced tools stay hidden. */
  beginnerMode: boolean
  /** Master switch for dependency health checks. */
  dependencyCheckEnabled: boolean
  /** Automatically check dependencies when a project is opened. */
  dependencyAutoScanOnOpen: boolean
  /** Poll the current project's dependency nodes for external file changes. */
  dependencyAutoWatch: boolean
  /** Offer the "auto fix" actions (all writes still require confirmation). */
  dependencyAutoRepair: boolean
}

export interface PathInfo {
  kind: PathKind
  oldRel: string
  newRel: string
  oldName: string
  newName: string
  oldAbs: string
  newAbs: string
  /** Non-fatal observations, e.g. the new path does not exist yet. */
  warnings: string[]
}

export interface PathPreviewRequest {
  projectId: number
  oldPath: string
  newPath: string
  kind: PathKindInput
}

export interface ScanRequest {
  projectId: number
  oldPath: string
  newPath: string
  kind: PathKindInput
  /** Omit to use the persisted settings. */
  modes?: MatchModes
}

export interface ScanProgress {
  phase: 'preparing' | 'walking' | 'scanning' | 'finalizing'
  filesScanned: number
  filesTotal: number
  currentFile: string | null
  percent: number
}

export interface ScanOccurrence {
  /** Stable within one scan; used for selection and apply. */
  id: string
  /** Path of the containing file relative to the project root, POSIX slashes. */
  filePath: string
  line: number
  column: number
  ruleId: number
  ruleKey: string
  ruleName: string
  ruleCategory: RuleCategory
  matchMode: MatchMode
  /** The full rule match, trimmed for display. */
  snippet: string
  /** The path text that will be replaced. */
  oldText: string
  /** The replacement path text. */
  newText: string
  /** Single-line context with up to 50 characters on each side. */
  context: string
  /** Absolute character offsets of `oldText` in the decoded file. */
  offset: number
  length: number
}

export interface ScanResult {
  scanToken: string
  projectId: number
  projectName: string
  projectRoot: string
  oldPathInput: string
  newPathInput: string
  pathInfo: PathInfo
  modes: MatchModes
  items: ScanOccurrence[]
  scannedFiles: number
  candidateFiles: number
  skippedFiles: number
  ignoredFiles: number
  durationMs: number
  warnings: string[]
  /** True when a global scan budget (bytes/time) stopped the scan early. */
  budgetStopped: boolean
  createdAt: string
}

/* ------------------------------------------------------------------ */
/* Automatic broken-reference check                                    */
/* ------------------------------------------------------------------ */

export type AutoCheckCandidateReason = 'same-name' | 'similar-name'

export interface AutoCheckCandidate {
  /** Project-relative POSIX path of a file that may be the moved target. */
  filePath: string
  reason: AutoCheckCandidateReason
  /** 0–100-ish confidence used only for ordering. */
  score: number
}

export interface AutoCheckReference {
  id: string
  filePath: string
  line: number
  column: number
  ruleName: string
  ruleCategory: RuleCategory
  /** The path text exactly as written in the source file. */
  rawText: string
  context: string
}

export interface AutoCheckGroup {
  /** Project-relative POSIX path that the broken references resolve to. */
  missingPath: string
  missingName: string
  references: AutoCheckReference[]
  /** Likely existing targets, ranked. Empty when nothing similar exists. */
  candidates: AutoCheckCandidate[]
}

export interface AutoCheckResult {
  projectId: number
  projectName: string
  projectRoot: string
  checkedFiles: number
  skippedFiles: number
  /** Number of path-like references inspected (healthy + broken). */
  referenceCount: number
  brokenReferenceCount: number
  groups: AutoCheckGroup[]
  warnings: string[]
  durationMs: number
  /** True when a global scan budget (bytes/time) stopped the check early. */
  budgetStopped: boolean
  createdAt: string
}

/* ------------------------------------------------------------------ */
/* Dependency health check                                             */
/* ------------------------------------------------------------------ */

export type DependencyRole = 'config' | 'source' | 'input' | 'cache' | 'output' | 'unknown'

export type DependencyHealth =
  | 'healthy'
  | 'missing'
  | 'unreadable'
  | 'corrupt'
  | 'format-mismatch'
  | 'version-mismatch'
  | 'ignored'

export type DependencyIssueSeverity = 'blocking' | 'warning' | 'info'

export type DependencyCandidateReason = 'same-name' | 'similar-name' | 'same-folder'

export interface DependencyCandidate {
  /** Project-relative POSIX path. */
  filePath: string
  reason: DependencyCandidateReason
  score: number
}

export interface DependencyReference {
  filePath: string
  line: number
  column: number
  ruleName: string
  ruleCategory: RuleCategory
  rawText: string
  context: string
}

export interface DependencyNode {
  id: string
  /** Project-relative POSIX path. Missing nodes still have a path. */
  path: string
  name: string
  role: DependencyRole
  health: DependencyHealth
  exists: boolean
  size: number | null
  modifiedAt: string | null
  incoming: number
  outgoing: number
  candidates: DependencyCandidate[]
  /** Human-readable observations, e.g. "文件为空" or "JSON 无法解析". */
  details: string[]
}

export interface DependencyEdge {
  id: string
  /** Node ids (source and target). */
  from: string
  to: string
  sourcePath: string
  targetPath: string
  line: number
  ruleName: string
  ruleCategory: RuleCategory
  rawText: string
  context: string
}

export interface DependencyIssue {
  id: string
  nodeId: string
  path: string
  name: string
  role: DependencyRole
  health: DependencyHealth
  severity: DependencyIssueSeverity
  title: string
  /** What the user sees, in plain language. */
  what: string
  /** Why it matters. */
  why: string
  /** Suggested next step, in plain language. */
  fixHint: string
  candidates: DependencyCandidate[]
  references: DependencyReference[]
  canAutoFix: boolean
  canReselect: boolean
  canRebuildCache: boolean
  canSkip: boolean
}

export interface DependencySummary {
  checkedFiles: number
  totalNodes: number
  totalEdges: number
  healthyNodes: number
  issueCount: number
  autoFixable: number
  ignoredCount: number
  roleCounts: Record<DependencyRole, number>
}

export interface DependencyScanResult {
  projectId: number
  projectName: string
  projectRoot: string
  nodes: DependencyNode[]
  edges: DependencyEdge[]
  issues: DependencyIssue[]
  summary: DependencySummary
  warnings: string[]
  durationMs: number
  /** True when a global scan budget (bytes/time) stopped the check early. */
  budgetStopped: boolean
  createdAt: string
}

export interface DependencyValidateFixRequest {
  projectId: number
  oldPath: string
  newPath: string
}

export interface DependencyValidation {
  valid: boolean
  /** Friendly validation errors; each entry is a complete sentence. */
  errors: string[]
  warnings: string[]
  oldPath: string
  newPath: string
}

export interface DependencyRepairResult {
  fixedIssuePath: string
  newPath: string
  changedFiles: number
  replacements: number
  backupId: number
  backupDir: string
  remainingIssueCount: number
}

export interface DependencyCacheRebuildResult {
  movedFiles: number
  backupDir: string
  paths: string[]
}

export interface DependencyIgnoreResult {
  ignoredPath: string
  ignored: boolean
}

export type DependencyChangeKind = 'missing' | 'appeared' | 'modified' | 'restored'

export interface DependencyChange {
  path: string
  kind: DependencyChangeKind
  before: string | null
  after: string | null
}

export interface DependencyChangesResult {
  changed: boolean
  changes: DependencyChange[]
  checkedAt: string
}

export interface DependencyPolicyDependency {
  path: string
  role?: DependencyRole
  /** Optional JSON field to read as the actual version (defaults to common keys). */
  versionField?: string
  minVersion?: string
  expectedSha256?: string
}

export interface DependencyPolicy {
  dependencies: DependencyPolicyDependency[]
}

export interface ApplyRequest {
  scanToken: string
  /** IDs of the occurrences the user explicitly checked. */
  occurrenceIds: string[]
}

export interface SkippedOccurrence {
  id: string
  filePath: string
  reason: string
}

export interface ApplyResult {
  migrationId: number
  backupId: number
  filesChanged: number
  replacements: number
  backupDir: string
  skipped: SkippedOccurrence[]
}

export interface MigrationFileInfo {
  id: number
  migrationId: number
  filePath: string
  backupPath: string
  preHash: string
  postHash: string
  replacements: number
}

export interface MigrationRecord {
  id: number
  projectId: number
  oldPath: string
  newPath: string
  kind: PathKind
  modes: MatchModes
  filesChanged: number
  replacements: number
  status: MigrationStatus
  backupId: number | null
  backupDir: string | null
  backupRemoved: boolean
  backupMissing: boolean
  error: string | null
  createdAt: string
  rolledBackAt: string | null
  files: MigrationFileInfo[]
}

export interface BackupRecord {
  id: number
  projectId: number
  migrationId: number | null
  dirName: string
  absPath: string
  filesCount: number
  sizeBytes: number
  createdAt: string
  missing: boolean
  /** True when the history record that created this backup has been deleted. */
  orphaned: boolean
}

export interface RollbackResult {
  migrationId: number
  filesRestored: number
  backupDir: string
}

export interface SelectedPath {
  absPath: string
  relPath: string
  exists: boolean
  kind: PathKind
}

export interface RuleValidation {
  valid: boolean
  error: string | null
  /** Name of the capture group that will be replaced, if valid. */
  captureGroup: string | null
}

export interface RuleTestResult extends RuleValidation {
  matchCount: number
  matches: string[]
}

export interface RuleInput {
  name: string
  description: string
  category: RuleCategory
  pattern: string
  flags: string
  enabled: boolean
  priority?: number
}

export interface IgnoreInput {
  pattern: string
  kind: IgnoreKind
  label?: string
  enabled?: boolean
}

export interface SystemInfo {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  platform: string
  userDataPath: string
}

export interface PickPathRequest {
  projectId: number
  side: 'old' | 'new'
  kind: PathKind
}

export interface SaveTextRequest {
  defaultName: string
  content: string
}

/* ------------------------------------------------------------------ */
/* Software scan (“扫描一个软件”)                                       */
/* ------------------------------------------------------------------ */

/** File version metadata read from the program itself; all fields nullable. */
export interface SoftwareInfo {
  productName: string | null
  fileDescription: string | null
  productVersion: string | null
  companyName: string | null
  entryPath: string | null
  /** Small PNG data URL produced by the OS icon lookup, when available. */
  iconDataUrl: string | null
}

/** What a progress-free `.exe/.lnk/install-directory` inspection returns. */
export interface SoftwareInspectResult {
  rootPath: string
  entryPath: string | null
  info: SoftwareInfo
  warnings: string[]
}

export type SoftwarePickMode = 'file' | 'directory'

export interface SoftwareAddRequest {
  rootPath: string
  entryPath: string | null
  name?: string
}

/**
 * How much of an installed software folder is content-scanned for text path
 * references. Installed programs contain bundled scripts, logs and generated
 * asset maps whose paths are resolved at runtime, so a full-text pass produces
 * mostly noise. `config` (default) only reads configuration formats.
 */
export type SoftwareTextScanScope = 'config' | 'all' | 'off'

export interface SoftwareScanRequest {
  projectId: number
  /** Include PE import-table analysis (P1). Defaults to true. */
  includeBinary?: boolean
  /** Text-reference scope. Defaults to `config`. */
  textScan?: SoftwareTextScanScope
}

export type BinaryDependencyOrigin = 'app-local' | 'system' | 'unknown'
export type BinaryDependencyStatus = 'ok' | 'missing' | 'unknown'

export interface BinaryDependency {
  /** DLL name exactly as imported, e.g. `vcruntime140.dll`. */
  name: string
  /** Absolute path where the DLL was found, or null when missing. */
  resolvedPath: string | null
  origin: BinaryDependencyOrigin
  status: BinaryDependencyStatus
  /** Program files (relative to the install root) that import this DLL. */
  importedBy: string[]
}

export type SoftwareBinaryAnalysis = 'not-analyzed' | 'analyzed' | 'unavailable'

export interface SoftwareScanResult {
  projectId: number
  projectName: string
  installRoot: string
  entryPath: string | null
  info: SoftwareInfo
  binaryAnalysis: SoftwareBinaryAnalysis
  /** Program files that were parsed for imports, relative to installRoot. */
  binaryFilesScanned: string[]
  binaryDependencies: BinaryDependency[]
  /** True when the import cap stopped the analysis early. */
  binaryCapHit: boolean
  /** Which text-reference scope produced `textReport`. */
  textScanScope: SoftwareTextScanScope
  /** References pointing into ignored/cache folders that were not counted. */
  textIssuesSkipped: number
  /** True when the software report capped the number of text issues shown. */
  textIssuesTruncated: boolean
  /** Text-reference report produced by the existing dependency engine. */
  textReport: DependencyScanResult | null
  warnings: string[]
  durationMs: number
  createdAt: string
}

/* ------------------------------------------------------------------ */
/* Read-only file previews (beginner candidate thumbnails)             */
/* ------------------------------------------------------------------ */

export type FilePreviewKind = 'image' | 'text' | 'unavailable'

export interface FilePreview {
  kind: FilePreviewKind
  /** PNG/JPEG data URL for images; null for other kinds. */
  dataUrl: string | null
  /** First few lines for text previews. */
  lines: string[]
  /** Original file size in bytes (0 when unknown). */
  size: number
  /** Plain-language reason when `kind` is `unavailable`. */
  reason: string | null
}

/** Envelope used by the main process for every IPC response. */
export interface SerializedError {
  code: string
  message: string
  details?: unknown
}

export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: SerializedError }
