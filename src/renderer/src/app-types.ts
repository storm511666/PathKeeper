import type { PathKindInput } from '@shared/types'

export type PageId = 'dependencies' | 'migration' | 'history' | 'settings' | 'software'

export const PAGE_TITLES: Record<PageId, string> = {
  dependencies: '智能检查',
  migration: '路径迁移',
  history: '迁移历史',
  settings: '设置中心',
  software: '软件体检'
}

/** One-shot prefill handed from history "重新扫描" to the migration composer. */
export interface MigrationSeed {
  oldPath: string
  newPath: string
  kind: PathKindInput
  nonce: number
}
