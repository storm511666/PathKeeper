import { createContext, useContext, type ReactNode } from 'react'
import type { PathKeeperApi } from '@shared/api'

const ApiContext = createContext<PathKeeperApi | null>(null)

export function ApiProvider({ api, children }: { api: PathKeeperApi; children: ReactNode }): ReactNode {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

export function useApi(): PathKeeperApi {
  const api = useContext(ApiContext)
  if (!api) {
    throw new Error('useApi 必须在 ApiProvider 内使用')
  }
  return api
}
