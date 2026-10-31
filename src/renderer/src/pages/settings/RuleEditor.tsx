import { useEffect, useState, type ReactNode } from 'react'
import type {
  MatchRule,
  RuleCategory,
  RuleInput,
  RuleTestResult,
  RuleValidation
} from '@shared/types'
import { CircleCheck, CircleX, FlaskConical } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { Modal } from '@renderer/components/Modal'
import { Button, Chip, Field, InlineError, Notice, Spinner } from '@renderer/components/ui'
import { describeError } from '@renderer/lib/errors'
import { CATEGORY_LABELS } from '@renderer/lib/labels'

const CATEGORIES: ReadonlyArray<RuleCategory> = [
  'markdown',
  'code',
  'config',
  'web',
  'workflow',
  'text',
  'custom'
]

export interface RuleEditorProps {
  open: boolean
  projectId: number
  /** Null means "create a custom rule". */
  rule: MatchRule | null
  onClose: () => void
  onSaved: (rule: MatchRule) => void
}

export function RuleEditor({ open, projectId, rule, onClose, onSaved }: RuleEditorProps): ReactNode {
  const api = useApi()
  const toast = useToast()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<RuleCategory>('custom')
  const [pattern, setPattern] = useState('')
  const [flags, setFlags] = useState('gi')
  const [sample, setSample] = useState('')

  const [validation, setValidation] = useState<RuleValidation | null>(null)
  const [validating, setValidating] = useState(false)
  const [testResult, setTestResult] = useState<RuleTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(rule?.name ?? '')
    setDescription(rule?.description ?? '')
    setCategory(rule?.category ?? 'custom')
    setPattern(rule?.pattern ?? '')
    setFlags(rule?.flags ?? 'gi')
    setSample('')
    setValidation(null)
    setValidating(false)
    setTestResult(null)
    setTesting(false)
    setSaving(false)
    setError(null)
  }, [open, rule])

  useEffect(() => {
    if (!open) return
    if (pattern.trim().length === 0) {
      setValidation(null)
      setValidating(false)
      return
    }
    let cancelled = false
    setValidating(true)
    const timer = setTimeout(() => {
      api.rules
        .validate(pattern, flags.trim())
        .then((result) => {
          if (!cancelled) setValidation(result)
        })
        .catch((validateError: unknown) => {
          if (!cancelled) {
            setValidation({
              valid: false,
              error: describeError(validateError).message,
              captureGroup: null
            })
          }
        })
        .finally(() => {
          if (!cancelled) setValidating(false)
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, open, pattern, flags])

  const handleTest = async (): Promise<void> => {
    if (pattern.trim().length === 0) {
      setError('请先填写正则表达式。')
      return
    }
    if (sample.trim().length === 0) {
      setError('请输入一段示例文本再测试。')
      return
    }
    setTesting(true)
    setError(null)
    setTestResult(null)
    try {
      const result = await api.rules.test(pattern, flags.trim(), sample)
      setTestResult(result)
    } catch (testError) {
      setError(describeError(testError).message)
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (name.trim().length === 0) {
      setError('请填写规则名称。')
      return
    }
    if (pattern.trim().length === 0) {
      setError('请填写正则表达式。')
      return
    }
    if (validation && !validation.valid) {
      setError(validation.error ?? '正则表达式无效。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const input: RuleInput = {
        name: name.trim(),
        description: description.trim(),
        category,
        pattern,
        flags: flags.trim(),
        enabled: rule?.enabled ?? true
      }
      let saved: MatchRule
      if (rule) {
        const patch: Partial<RuleInput> = rule.builtin
          ? { pattern, flags: flags.trim() }
          : input
        saved = await api.rules.update(rule.id, patch)
      } else {
        saved = await api.rules.add(projectId, input)
      }
      onSaved(saved)
      toast.success(rule ? '匹配规则已更新' : '自定义匹配规则已添加', saved.name)
      onClose()
    } catch (saveError) {
      const described = describeError(saveError)
      setError(described.message)
      toast.error('保存匹配规则失败', described.message)
    } finally {
      setSaving(false)
    }
  }

  const isBuiltin = rule?.builtin === true
  const title = rule ? (isBuiltin ? '编辑内置匹配规则' : '编辑自定义匹配规则') : '新增自定义匹配规则'

  return (
    <Modal
      open={open}
      title={title}
      description="规则必须暴露一个命名捕获组 path（或唯一捕获组），PathKeeper 只替换该捕获组命中的路径文本。"
      onClose={() => {
        if (!saving) onClose()
      }}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void handleSave()}>
            {rule ? '保存修改' : '添加规则'}
          </Button>
        </>
      }
    >
      <div className="rule-editor">
        {isBuiltin ? (
          <Notice tone="info" compact>
            这是内置规则：只能修改正则表达式与 flags；名称、分类和说明保持内置定义。
          </Notice>
        ) : null}

        <div className="rule-editor-grid">
          <Field label="规则名称" htmlFor="rule-name">
            <input
              id="rule-name"
              className="input"
              value={name}
              maxLength={80}
              disabled={isBuiltin}
              placeholder="例如 日志中的绝对路径"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="分类" htmlFor="rule-category">
            <select
              id="rule-category"
              className="select"
              value={category}
              disabled={isBuiltin}
              onChange={(event) => setCategory(event.target.value as RuleCategory)}
            >
              {CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {CATEGORY_LABELS[item]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="说明" htmlFor="rule-description" optional>
          <input
            id="rule-description"
            className="input"
            value={description}
            maxLength={240}
            disabled={isBuiltin}
            placeholder="这条规则覆盖什么文件？路径通常写在什么位置？"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field
          label="正则表达式"
          htmlFor="rule-pattern"
          hint="使用命名捕获组 (?<path>…) 或单一捕获组标记要替换的路径。不要写 / 定界符。"
        >
          <textarea
            id="rule-pattern"
            className="input textarea input-mono"
            rows={5}
            value={pattern}
            spellCheck={false}
            onChange={(event) => setPattern(event.target.value)}
          />
        </Field>

        <div className="rule-flags-row">
          <Field
            label="Flags"
            htmlFor="rule-flags"
            className="rule-flags-field"
            hint="不需要 g / d，扫描时自动添加。常用：i（忽略大小写）、m（多行）。"
          >
            <input
              id="rule-flags"
              className="input input-mono"
              value={flags}
              maxLength={8}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setFlags(event.target.value)}
            />
          </Field>
          <div className="rule-validation" aria-live="polite">
            {validating ? (
              <Spinner label="正在验证正则…" />
            ) : validation ? (
              validation.valid ? (
                <span className="rule-validation-ok">
                  <CircleCheck size={14} aria-hidden="true" /> 正则有效
                  {validation.captureGroup ? (
                    <Chip tone="mint" mono>
                      {validation.captureGroup}
                    </Chip>
                  ) : null}
                </span>
              ) : (
                <span className="rule-validation-bad">
                  <CircleX size={14} aria-hidden="true" /> {validation.error ?? '正则无效'}
                </span>
              )
            ) : (
              <span className="rule-validation-idle">输入正则后会实时验证。</span>
            )}
          </div>
        </div>

        <div className="rule-test">
          <p className="settings-block-title">示例测试</p>
          <div className="rule-test-row">
            <input
              className="input input-mono"
              value={sample}
              placeholder={'例如 open("assets/old.png", "rb")'}
              spellCheck={false}
              aria-label="正则测试示例文本"
              onChange={(event) => {
                setSample(event.target.value)
                setTestResult(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleTest()
              }}
            />
            <Button
              variant="default"
              icon={<FlaskConical size={14} />}
              loading={testing}
              disabled={sample.trim().length === 0 || pattern.trim().length === 0}
              onClick={() => void handleTest()}
            >
              测试匹配
            </Button>
          </div>
          {testResult ? (
            testResult.valid ? (
              <div className="rule-test-result">
                <p>
                  在示例中匹配到 <strong>{testResult.matchCount}</strong> 处
                  {testResult.captureGroup ? (
                    <span className="mono rule-test-group">（捕获组：{testResult.captureGroup}）</span>
                  ) : null}
                </p>
                {testResult.matches.length > 0 ? (
                  <ul className="rule-test-matches">
                    {testResult.matches.slice(0, 6).map((match, index) => (
                      <li key={`${match}-${index}`}>
                        <code className="mono">{match}</code>
                      </li>
                    ))}
                    {testResult.matches.length > 6 ? (
                      <li className="rule-test-more">…以及另外 {testResult.matches.length - 6} 处</li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="rule-test-empty">示例文本中没有命中，可调整示例或正则。</p>
                )}
              </div>
            ) : (
              <InlineError message={testResult.error ?? '测试失败。'} />
            )
          ) : null}
        </div>

        {error ? <InlineError message={error} /> : null}
      </div>
    </Modal>
  )
}
