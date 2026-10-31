import type {
  IgnoreKind,
  MatchMode,
  MigrationStatus,
  PathKind,
  PathKindInput,
  RuleCategory,
  ScanProgress
} from '@shared/types'

export const CATEGORY_LABELS: Record<RuleCategory, string> = {
  markdown: 'Markdown',
  code: '代码',
  config: '配置',
  web: 'Web 资源',
  workflow: '工作流',
  text: '文本',
  custom: '自定义'
}

export const MATCH_MODE_LABELS: Record<MatchMode, string> = {
  strict: '严格匹配',
  basename: '文件名匹配',
  directory: '目录重映射'
}

export const STATUS_LABELS: Record<MigrationStatus, string> = {
  pending: '待处理',
  applied: '已应用',
  rolled_back: '已回滚',
  failed: '失败'
}

export const KIND_LABELS: Record<PathKind, string> = {
  file: '文件',
  directory: '目录'
}

export const KIND_INPUT_LABELS: Record<PathKindInput, string> = {
  auto: '自动判断',
  file: '文件',
  directory: '目录'
}

export const IGNORE_KIND_LABELS: Record<IgnoreKind, string> = {
  dir: '目录',
  suffix: '后缀',
  glob: '通配'
}

export const PHASE_LABELS: Record<ScanProgress['phase'], string> = {
  preparing: '准备文件清单',
  walking: '遍历项目目录',
  scanning: '扫描文本引用',
  finalizing: '汇总结果'
}

export function categoryLabel(category: RuleCategory): string {
  return CATEGORY_LABELS[category]
}

export function statusLabel(status: MigrationStatus): string {
  return STATUS_LABELS[status]
}

export function matchModeLabel(mode: MatchMode): string {
  return MATCH_MODE_LABELS[mode]
}

export function pathKindLabel(kind: PathKind): string {
  return KIND_LABELS[kind]
}

export function pathKindInputLabel(kind: PathKindInput): string {
  return KIND_INPUT_LABELS[kind]
}

export function ignoreKindLabel(kind: IgnoreKind): string {
  return IGNORE_KIND_LABELS[kind]
}

export function scanPhaseLabel(phase: ScanProgress['phase']): string {
  return PHASE_LABELS[phase]
}
