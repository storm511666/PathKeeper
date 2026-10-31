import { useState, type ReactNode } from 'react'
import type { AppSettings } from '@shared/types'
import { Eye, Radar, ShieldCheck, Wrench } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { describeError } from '@renderer/lib/errors'
import { Notice, Toggle } from '@renderer/components/ui'
import { HelpTip } from '@renderer/components/HelpTip'

export interface DependencySettingsSectionProps {
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

interface SwitchRowProps {
  title: string
  description: string
  checked: boolean
  onChange: (value: boolean) => Promise<void>
  disabled?: boolean
  testId: string
  icon: ReactNode
  help?: ReactNode
}

function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled = false,
  testId,
  icon,
  help
}: SwitchRowProps): ReactNode {
  const [saving, setSaving] = useState(false)
  return (
    <div className="settings-switch-row">
      <span className="settings-switch-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="settings-switch-copy">
        <p>
          {title}
          {help ? <HelpTip>{help}</HelpTip> : null}
        </p>
        <small>{description}</small>
      </div>
      <Toggle
        checked={checked}
        disabled={disabled || saving}
        label={title}
        testId={testId}
        onChange={(value) => {
          setSaving(true)
          void onChange(value).finally(() => setSaving(false))
        }}
      />
    </div>
  )
}

export function DependencySettingsSection({
  settings,
  onSettingsChange
}: DependencySettingsSectionProps): ReactNode {
  const api = useApi()
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)

  const update = async (patch: Partial<AppSettings>, message: string): Promise<void> => {
    setError(null)
    try {
      const updated = await api.settings.update(patch)
      onSettingsChange(updated)
      toast.success(message)
    } catch (saveError) {
      const described = describeError(saveError)
      setError(described.message)
      toast.error('保存失败', described.message)
    }
  }

  return (
    <section className="settings-panel" aria-labelledby="settings-deps-title">
      <header className="settings-panel-head">
        <div>
          <p className="plate-kicker mono">设置 / 智能检查</p>
          <h2 className="settings-panel-title" id="settings-deps-title">
            智能检查与自动修复
          </h2>
          <p className="settings-panel-desc">
            这些开关控制 PathKeeper 的依赖体检能力。关闭任何一项都不会删除项目文件，
            也不会影响原来的手动路径迁移。
          </p>
        </div>
        <ShieldCheck size={18} className="settings-panel-icon" aria-hidden="true" />
      </header>

      <div className="settings-main">
        <div className="settings-block">
          <p className="settings-block-title">总开关</p>
          <SwitchRow
            title="启用智能检查"
            description="关闭后，“智能检查”页面不扫描；手动路径迁移仍然可用。"
            checked={settings.dependencyCheckEnabled}
            onChange={(value) =>
              update(
                { dependencyCheckEnabled: value },
                value ? '智能检查已开启' : '智能检查已关闭'
              )
            }
            testId="toggle-dependency-enabled"
            icon={<Eye size={16} />}
            help="总开关。关闭后，启动时和打开工程时都不会自动扫描依赖。"
          />
        </div>

        <div className="settings-block">
          <p className="settings-block-title">检查时机</p>
          <SwitchRow
            title="打开工程时自动体检"
            description="打开或切换工程时，自动检查一次文件依赖。"
            checked={settings.dependencyAutoScanOnOpen}
            disabled={!settings.dependencyCheckEnabled}
            onChange={(value) =>
              update(
                { dependencyAutoScanOnOpen: value },
                value ? '打开工程时自动体检已开启' : '打开工程时自动体检已关闭'
              )
            }
            testId="toggle-dependency-autoscan"
            icon={<Radar size={16} />}
            help="每次切换工程时自动扫描一遍。工程很大时可以关掉，改为手动点“重新体检”。"
          />
          <SwitchRow
            title="自动感知文件变动"
            description="在后台轻量检查当前工程的依赖文件；文件移动/改名/删除后主动提示。"
            checked={settings.dependencyAutoWatch}
            disabled={!settings.dependencyCheckEnabled}
            onChange={(value) =>
              update(
                { dependencyAutoWatch: value },
                value ? '文件变动提醒已开启' : '文件变动提醒已关闭'
              )
            }
            testId="toggle-dependency-autowatch"
            icon={<Radar size={16} />}
            help="只监控当前工程已经建立依赖关系的文件，不扫描整个磁盘。默认每 4 秒轻量检查一次。"
          />
        </div>

        <div className="settings-block">
          <p className="settings-block-title">修复方式</p>
          <SwitchRow
            title="显示自动修复建议"
            description="在问题卡片上提供“一键修复”和“一键修复简单项”；所有写入仍需你二次确认。"
            checked={settings.dependencyAutoRepair}
            disabled={!settings.dependencyCheckEnabled}
            onChange={(value) =>
              update(
                { dependencyAutoRepair: value },
                value ? '自动修复建议已开启' : '自动修复建议已关闭'
              )
            }
            testId="toggle-dependency-autorepair"
            icon={<Wrench size={16} />}
            help="关闭后仍可以手动选择文件和跳过问题；不会自动修改文件。"
          />
        </div>

        {!settings.beginnerMode ? (
          <Notice tone="info" title="高级模式已开启">
            手动路径迁移、匹配规则、忽略规则和备份管理现在都在左侧导航与设置分页中可见。
          </Notice>
        ) : null}

        {error ? (
          <Notice tone="danger" title="设置没有保存">
            {error}
          </Notice>
        ) : null}
      </div>
    </section>
  )
}
