import { useEffect, useState, type ReactNode } from 'react'
import type { SystemInfo } from '@shared/types'
import { Copy, Database, HardDrive, ShieldCheck, WifiOff } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { describeError } from '@renderer/lib/errors'
import { copyText } from '@renderer/lib/clipboard'
import { Button, InlineError, Spinner } from '@renderer/components/ui'

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

export function AboutSection(): ReactNode {
  const api = useApi()
  const toast = useToast()
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.system
      .info()
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch((infoError: unknown) => {
        if (!cancelled) setError(describeError(infoError).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const handleCopy = async (value: string): Promise<void> => {
    const copied = await copyText(value)
    if (copied) toast.success('已复制到剪贴板')
    else toast.error('无法复制到剪贴板', '请手动选择文本复制。')
  }

  return (
    <section className="settings-panel" aria-labelledby="settings-about-title">
      <header className="settings-panel-head">
        <div>
          <p className="plate-kicker mono">设置 / 关于与隐私</p>
          <h2 className="settings-panel-title" id="settings-about-title">
            关于 PathKeeper
          </h2>
          <p className="settings-panel-desc">
            一个完全离线的 Windows 桌面工具：查找并安全修复项目中被移动的文件路径引用。
          </p>
        </div>
        <ShieldCheck size={20} className="settings-panel-icon" aria-hidden="true" />
      </header>

      <div className="settings-body">
        {loading ? (
          <div className="page-state" role="status">
            <Spinner label="正在读取版本信息…" />
          </div>
        ) : error ? (
          <InlineError message={error} />
        ) : info ? (
          <div className="about-grid">
            <section className="about-block" aria-labelledby="about-version">
              <h3 className="settings-block-title" id="about-version">
                版本信息
              </h3>
              <dl className="definition-list definition-list-compact">
                <div>
                  <dt>PathKeeper</dt>
                  <dd className="mono">{info.appVersion}</dd>
                </div>
                <div>
                  <dt>Electron</dt>
                  <dd className="mono">{info.electronVersion}</dd>
                </div>
                <div>
                  <dt>Chromium</dt>
                  <dd className="mono">{info.chromeVersion}</dd>
                </div>
                <div>
                  <dt>Node.js</dt>
                  <dd className="mono">{info.nodeVersion}</dd>
                </div>
                <div>
                  <dt>平台</dt>
                  <dd className="mono">{PLATFORM_LABELS[info.platform] ?? info.platform}</dd>
                </div>
              </dl>
            </section>

            <section className="about-block" aria-labelledby="about-data">
              <h3 className="settings-block-title" id="about-data">
                本地数据位置
              </h3>
              <p className="about-copy">
                项目列表、设置、迁移记录和备份清单保存在本机 SQLite 数据库
                <code className="mono inline-code">pathkeeper.sqlite</code> 中。备份文件保存在各项目根目录下的
                <code className="mono inline-code">.pathkeeper-backup/</code>。
              </p>
              <div className="about-path-row">
                <code className="about-path mono" title={info.userDataPath}>
                  {info.userDataPath}
                </code>
                <Button
                  variant="default"
                  size="sm"
                  icon={<Copy size={13} />}
                  onClick={() => void handleCopy(info.userDataPath)}
                >
                  复制路径
                </Button>
              </div>
              <div className="about-facts">
                <span>
                  <Database size={13} aria-hidden="true" /> 数据库仅本机可访问
                </span>
                <span>
                  <HardDrive size={13} aria-hidden="true" /> 备份不会自动清理
                </span>
              </div>
            </section>

            <section className="about-block about-block-wide" aria-labelledby="about-privacy">
              <h3 className="settings-block-title" id="about-privacy">
                隐私与离线承诺
              </h3>
              <ul className="about-privacy-list">
                <li>
                  <WifiOff size={14} aria-hidden="true" />
                  <div>
                    <strong>没有网络请求。</strong>
                    不加载远程字体、图片或脚本，不发送使用数据，也没有遥测。
                  </div>
                </li>
                <li>
                  <ShieldCheck size={14} aria-hidden="true" />
                  <div>
                    <strong>没有账号与云同步。</strong>
                    所有数据只在本机；没有自动更新，也不会连接外部服务。
                  </div>
                </li>
                <li>
                  <ShieldCheck size={14} aria-hidden="true" />
                  <div>
                    <strong>写入需要明确确认。</strong>
                    扫描默认只读；只有核对选中行并确认后才会写入，且写入前一定先备份。
                  </div>
                </li>
                <li>
                  <HardDrive size={14} aria-hidden="true" />
                  <div>
                    <strong>备份由你管理。</strong>
                    备份保留在你的项目目录中，PathKeeper 不会自动删除；需要空间时可在备份管理中手动清理。
                    删除备份后，对应历史记录无法回滚。
                  </div>
                </li>
              </ul>
            </section>
          </div>
        ) : null}
      </div>
    </section>
  )
}
