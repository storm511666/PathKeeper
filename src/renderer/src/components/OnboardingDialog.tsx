import type { ReactNode } from 'react'
import { CheckCircle2, MousePointerClick, ScanSearch, ShieldCheck, Sparkles } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/ui'

export interface OnboardingDialogProps {
  open: boolean
  loadingSample: boolean
  hasProject: boolean
  onLoadSample: () => void
  onClose: () => void
}

const STEPS = [
  {
    icon: <MousePointerClick size={20} />,
    title: '选一个工程',
    body: '第一次可以直接加载内置示例。它故意留了一个“文件搬走了”的小问题，用来带你走完整条路。'
  },
  {
    icon: <ScanSearch size={20} />,
    title: '让软件自动体检',
    body: '点“开始体检”，软件会自己找出缺失文件、路径变化和格式异常，不需要你先填旧路径/新路径。'
  },
  {
    icon: <ShieldCheck size={20} />,
    title: '确认修复，自动备份',
    body: '选择软件推荐的位置，或自己选文件。写入前会再次确认并自动备份，改错可在历史里回滚。'
  }
]

export function OnboardingDialog({
  open,
  loadingSample,
  hasProject,
  onLoadSample,
  onClose
}: OnboardingDialogProps): ReactNode {
  return (
    <Modal
      open={open}
      title="第一次用 PathKeeper？三步就够了"
      description="不用懂路径术语，也不用先改配置。先跟着示例跑通一次，你马上就知道它是做什么的。"
      onClose={onClose}
      width="lg"
      testId="onboarding-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            以后再说
          </Button>
          <Button
            variant="primary"
            icon={<Sparkles size={15} />}
            loading={loadingSample}
            autoFocus
            data-testid="onboarding-load-sample"
            onClick={onLoadSample}
          >
            一键加载示例工程
          </Button>
        </>
      }
    >
      <div className="onboarding-body">
        <div className="onboarding-steps">
          {STEPS.map((step, index) => (
            <article className="onboarding-step" key={step.title}>
              <span className="onboarding-step-index mono">{String(index + 1).padStart(2, '0')}</span>
              <span className="onboarding-step-icon" aria-hidden="true">
                {step.icon}
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
        <div className="onboarding-note">
          <CheckCircle2 size={15} aria-hidden="true" />
          <span>
            {hasProject
              ? '你已经有一个工程了，也可以稍后直接打开它体检。'
              : '示例工程会复制到 PathKeeper 的本地数据目录，不会修改项目里的任何文件。'}
          </span>
        </div>
      </div>
    </Modal>
  )
}
