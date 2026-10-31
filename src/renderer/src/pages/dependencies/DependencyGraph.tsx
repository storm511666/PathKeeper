import { useMemo, type ReactNode } from 'react'
import type {
  DependencyNode,
  DependencyRole,
  DependencyScanResult
} from '@shared/types'
import { HelpTip } from '@renderer/components/HelpTip'

const ROLE_LABEL: Record<DependencyRole, string> = {
  config: '配置',
  source: '源文件',
  input: '输入',
  cache: '缓存',
  output: '输出',
  unknown: '其他'
}

const COLUMN_BY_ROLE: Record<DependencyRole, number> = {
  config: 0,
  input: 0,
  source: 1,
  output: 2,
  cache: 2,
  unknown: 1
}

const COLUMN_X = [24, 330, 660]
const NODE_W = 200
const NODE_H = 28
const GAP = 9
const TOP = 34

function shortPath(path: string, max = 25): string {
  if (path.length <= max) return path
  return `…${path.slice(-(max - 1))}`
}

function visibleNodes(scan: DependencyScanResult): { nodes: DependencyNode[]; truncated: boolean } {
  if (scan.nodes.length <= 42) return { nodes: scan.nodes, truncated: false }
  const issueNodeIds = new Set(scan.issues.map((issue) => issue.nodeId))
  const keep = new Set<string>(issueNodeIds)
  for (const edge of scan.edges) {
    if (keep.has(edge.from) || keep.has(edge.to)) {
      keep.add(edge.from)
      keep.add(edge.to)
    }
  }
  const nodes = scan.nodes.filter((node) => keep.has(node.id)).slice(0, 42)
  return { nodes, truncated: true }
}

/**
 * A deliberately small, dependency-free SVG graph. It is a map, not an editor:
 * roles are columns, arrows are references, red dashed nodes are missing.
 */
export function DependencyGraph({ scan }: { scan: DependencyScanResult }): ReactNode {
  const { nodes, truncated } = useMemo(() => visibleNodes(scan), [scan])
  const layout = useMemo(() => {
    const byColumn = new Map<number, DependencyNode[]>()
    for (const node of nodes) {
      const col = COLUMN_BY_ROLE[node.role] ?? 1
      const list = byColumn.get(col) ?? []
      list.push(node)
      byColumn.set(col, list)
    }
    const positions = new Map<string, { x: number; y: number }>()
    const maxRows = Math.max(1, ...[...byColumn.values()].map((list) => list.length))
    const available = 390 - TOP
    const step = Math.min(NODE_H + GAP, Math.max(18, available / maxRows))
    for (const [col, list] of byColumn.entries()) {
      list.sort((left, right) => left.role.localeCompare(right.role) || left.path.localeCompare(right.path, 'zh-CN'))
      list.forEach((node, index) => {
        positions.set(node.id, {
          x: COLUMN_X[col] ?? COLUMN_X[1]!,
          y: TOP + index * step
        })
      })
    }
    return { positions, maxRows, graphHeight: Math.max(190, TOP + maxRows * step + 18) }
  }, [nodes])
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const visibleEdges = useMemo(
    () =>
      scan.edges
        .filter((edge) => layout.positions.has(edge.from) && layout.positions.has(edge.to))
        .slice(0, 90),
    [layout, scan.edges]
  )

  return (
    <section className="dependency-graph-card" aria-labelledby="dependency-graph-title">
      <header className="dependency-graph-head">
        <div>
          <p className="plate-kicker mono">文件关系图</p>
          <h2 id="dependency-graph-title">谁在引用谁，一眼看懂</h2>
        </div>
        <div className="dependency-graph-legend" aria-label="文件类型图例">
          <span><i className="dot dot-config" />配置</span>
          <span><i className="dot dot-source" />源文件</span>
          <span><i className="dot dot-input" />输入</span>
          <span><i className="dot dot-output" />输出</span>
          <span><i className="dot dot-cache" />缓存</span>
          <span><i className="dot dot-missing" />找不到</span>
          <HelpTip>
            箭头表示“这个文件引用了另一个文件”。圆的颜色是软件对文件类型的判断；
            红色虚线框表示当前找不到文件。图只是帮助理解，不会修改任何内容。
          </HelpTip>
        </div>
      </header>

      <div className="dependency-graph-scroll">
        <svg
          className="dependency-graph"
          viewBox={`0 0 900 ${layout.graphHeight}`}
          role="img"
          aria-label="项目文件依赖关系图"
          data-testid="dependency-graph"
        >
          <defs>
            <marker id="dep-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill="#415963" />
            </marker>
            <marker id="dep-arrow-missing" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill="#cf7266" />
            </marker>
          </defs>
          {visibleEdges.map((edge) => {
            const from = layout.positions.get(edge.from)
            const to = layout.positions.get(edge.to)
            if (!from || !to) return null
            const target = nodesById.get(edge.to)
            const missing = target?.health === 'missing'
            const x1 = from.x + NODE_W
            const y1 = from.y + NODE_H / 2
            const x2 = to.x
            const y2 = to.y + NODE_H / 2
            const mid = (x1 + x2) / 2
            return (
              <path
                key={edge.id}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                className={`dependency-edge${missing ? ' is-missing' : ''}`}
                markerEnd={missing ? 'url(#dep-arrow-missing)' : 'url(#dep-arrow)'}
              />
            )
          })}
          {nodes.map((node) => {
            const position = layout.positions.get(node.id)
            if (!position) return null
            const missing = node.health === 'missing'
            return (
              <g
                key={node.id}
                className={`dependency-node role-${node.role}${missing ? ' is-missing' : ''}`}
                transform={`translate(${position.x}, ${position.y})`}
              >
                <title>
                  {node.path} · {ROLE_LABEL[node.role]} ·
                  {missing ? ' 找不到文件' : node.health === 'healthy' ? ' 正常' : ' 需要关注'}
                </title>
                <rect width={NODE_W} height={NODE_H} rx={7} />
                <circle cx={12} cy={NODE_H / 2} r={3.5} />
                <text x={23} y={18} className="dependency-node-name">
                  {shortPath(node.name, 23)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <p className="dependency-graph-note">
        {truncated
          ? `节点较多，图中只展示与问题相关的 ${nodes.length} 个文件；完整清单以体检结果为准。`
          : `共 ${nodes.length} 个文件节点、${scan.summary.totalEdges} 条引用关系。`}
      </p>
    </section>
  )
}
