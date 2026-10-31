/**
 * PathKeeper core engine — public API.
 *
 * Everything exported here is pure Node (no Electron, no DB, no network) so the
 * backend can use it directly and tests can drive it deterministically.
 */

export {
  CoreError,
  createAbortError,
  errorMessage,
  isAbortError,
  isCoreError
} from './errors'
export type { CoreErrorCode, CoreErrorCodeValue } from './errors'

export {
  formatWithSeparator,
  isInside,
  looksAbsolutePath,
  normalizeSlashes,
  relativeBaseName,
  relativeDirName,
  resolveMigrationPaths,
  resolveProjectRoot,
  resolveUserPath,
  toNativeSeparators,
  toProjectRelative,
  tryStatKind
} from './path'

export {
  applyTextEdits,
  buildLineStarts,
  decodeTextBuffer,
  encodeTextBuffer,
  extractLineContext,
  lineColumnAt,
  lineColumnFromStarts,
  looksBinary
} from './text'
export type { DecodedText, TextEdit } from './text'

export {
  captureSpan,
  compileMatchRule,
  countCaptureGroups,
  extractNamedGroupNames,
  sanitizeRuleFlags,
  testMatchRule,
  validateMatchRule
} from './rules'
export type { CompiledRule, SanitizedFlags } from './rules'

export {
  budgetExhausted,
  chargeRead,
  classifyHead,
  createReadBudget,
  DEFAULT_SCAN_BUDGET_BYTES,
  DEFAULT_SCAN_BUDGET_MS,
  FULL_READ_MAX_BYTES,
  hashFileStreaming,
  HEAD_SNIFF_BYTES,
  isStreamableEncoding,
  MAX_JSON_PARSE_BYTES,
  MAX_STREAM_HASH_BYTES,
  probeTextFile,
  readFullTextFile,
  REPORT_ONLY_WARN_BYTES,
  streamTextLines,
  StreamBinaryError,
  StreamEncodingError
} from './safeRead'
export type {
  FullTextRead,
  ProbeEncoding,
  ReadBudget,
  ScanBudgetOptions,
  StreamTextOptions,
  TextFileProbe,
  TextStreamLine
} from './safeRead'

export { createIgnoreEvaluator, globToRegExp } from './ignore'
export type { IgnoreEvaluator, IgnoreEvaluatorOptions } from './ignore'

export {
  analyzeReference,
  evaluateReference,
  formatReplacement,
  matchReference,
  resolveReferenceCandidates,
  unescapeJsonPath
} from './match'
export type {
  AnalyzedReference,
  MigrationTarget,
  ReferenceBranch,
  ReferenceEvaluation,
  ReferenceMatch,
  ReferenceStyle
} from './match'

export { scanProject } from './scan'
export type { EngineScanResult, ScanProjectOptions, ScanSnapshot } from './scan'

export { autoCheckProject } from './autoCheck'
export type { AutoCheckProjectOptions } from './autoCheck'

export { classifyDependencyRole, diffDependencyNode, scanDependencies } from './dependencyScan'
export type { DependencyScanOptions } from './dependencyScan'
