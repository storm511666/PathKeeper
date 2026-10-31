import { describe, expect, it } from 'vitest'
import type { DependencyCandidateReason, RuleCategory } from '../../src/shared/types'
import {
  HUMAN_ROLE_LABELS,
  IF_IGNORED_WITHOUT_CANDIDATES,
  STATIC_CHECK_LIMIT_NOTE,
  UNKNOWN_ENGLISH_TITLE,
  candidateReasonEvidence,
  formatHumanFileSummary,
  humanizeCandidateExplanation,
  humanizeFileView,
  humanizeMissingReason,
  humanizeReferenceUsage,
  humanizeSoftwareFile,
  splitFileNameTokens
} from '../../src/shared/fileHumanize'

const CHINESE_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * Plan C7 acceptance table — must pass EXACTLY. The summary column is what a
 * beginner sees on the card: `${typeLabel} ·「${title}」`.
 */
const C7_ACCEPTANCE: Array<{
  path: string
  typeLabel: string
  title: string
  summary: string
  role: 'config' | 'source' | 'input' | 'cache' | 'output' | 'unknown'
  confidence: 'high' | 'medium' | 'low'
}> = [
  {
    path: 'assets/textures/old_brick_wall.png',
    typeLabel: '图片素材',
    title: '砖墙贴图（旧）',
    summary: '图片素材 ·「砖墙贴图（旧）」',
    role: 'input',
    confidence: 'high'
  },
  {
    path: 'assets/materials/brick_wall.png',
    typeLabel: '图片素材',
    title: '砖墙贴图',
    summary: '图片素材 ·「砖墙贴图」',
    role: 'input',
    confidence: 'high'
  },
  {
    path: 'configs/pipeline.json',
    typeLabel: '配置文件',
    title: '流程配置',
    summary: '配置文件 ·「流程配置」',
    role: 'config',
    confidence: 'high'
  },
  {
    path: 'scripts/preprocess.py',
    typeLabel: 'Python 脚本',
    title: '预处理脚本',
    summary: 'Python 脚本 ·「预处理脚本」',
    role: 'source',
    confidence: 'high'
  },
  {
    path: 'output/preview.json',
    typeLabel: '结果文件',
    title: '预览结果',
    summary: '结果文件 ·「预览结果」',
    role: 'output',
    confidence: 'high'
  },
  {
    path: 'fdgfdg.png',
    typeLabel: '图片素材',
    title: UNKNOWN_ENGLISH_TITLE,
    summary: '图片素材 ·「英文文件名，暂时无法解释」',
    role: 'input',
    confidence: 'medium'
  }
]

describe('C7 acceptance table', () => {
  for (const sample of C7_ACCEPTANCE) {
    it(`humanizes ${sample.path} exactly`, () => {
      const view = humanizeFileView(sample.path)
      expect(view.typeLabel).toBe(sample.typeLabel)
      expect(view.title).toBe(sample.title)
      expect(formatHumanFileSummary(view)).toBe(sample.summary)
      expect(view.role).toBe(sample.role)
      expect(view.confidence).toBe(sample.confidence)
      expect(view.originalPath).toBe(sample.path)
    })
  }
})

describe('unknown English names are never fabricated', () => {
  it('returns the honest fallback title and explanation', () => {
    const view = humanizeFileView('fdgfdg.png')
    expect(view.title).toBe('英文文件名，暂时无法解释')
    expect(view.explanation).toBe('英文文件名，暂时无法解释')
    expect(view.typeLabel).toBe('图片素材')
    expect(view.roleLabel).toBe('素材')
    // The raw name stays reachable through the original path and breadcrumb.
    expect(view.originalPath).toBe('fdgfdg.png')
    expect(view.pathBreadcrumb).toBe('项目 / fdgfdg.png')
    expect(view.pathBreadcrumb).not.toContain('未知翻译')
  })

  it('does not translate random words, even when the type is known', () => {
    const view = humanizeFileView('assets/textures/qwerty.png')
    expect(view.title).toBe(UNKNOWN_ENGLISH_TITLE)
    expect(view.title).not.toContain('qwerty')
    expect(view.typeLabel).toBe('图片素材')
  })

  it('falls back when only some tokens are known', () => {
    const view = humanizeFileView('assets/textures/brick_xyzzy_wall.png')
    expect(view.title).toBe(UNKNOWN_ENGLISH_TITLE)
    // Known prefix must not leak a half-invented translation into the title.
    expect(view.title).not.toContain('砖')
  })

  it('handles a completely unknown extension as a normal file', () => {
    const view = humanizeFileView('notes/abc123.xyz')
    expect(view.role).toBe('unknown')
    expect(view.roleLabel).toBe('普通文件')
    expect(view.typeLabel).toBe('普通文件')
    expect(view.title).toBe(UNKNOWN_ENGLISH_TITLE)
    expect(view.confidence).toBe('low')
    expect(view.pathBreadcrumb).toBe('项目 / notes / abc123.xyz')
  })
})

describe('token splitting', () => {
  it('splits snake_case, kebab-case, camelCase and PascalCase', () => {
    expect(splitFileNameTokens('old_brick_wall')).toEqual(['old', 'brick', 'wall'])
    expect(splitFileNameTokens('old-brick-wall')).toEqual(['old', 'brick', 'wall'])
    expect(splitFileNameTokens('oldBrickWall')).toEqual(['old', 'brick', 'wall'])
    expect(splitFileNameTokens('OldBrickWall')).toEqual(['old', 'brick', 'wall'])
    expect(splitFileNameTokens('brick')).toEqual(['brick'])
  })

  it('keeps number tokens when the rest of the name is understandable', () => {
    const view = humanizeFileView('assets/textures/brick_wall_01.png')
    expect(view.title).toBe('砖墙贴图 01')
    expect(view.confidence).toBe('high')
  })
})

describe('path handling', () => {
  it('keeps the original path exactly as provided (including backslashes)', () => {
    const raw = 'assets\\textures\\old_brick_wall.png'
    const view = humanizeFileView(raw)
    expect(view.originalPath).toBe(raw)
    expect(view.title).toBe('砖墙贴图（旧）')
    expect(view.pathBreadcrumb).toBe('项目 / 素材 / 贴图 / 砖墙贴图（旧）')
  })

  it('normalizes uppercase extensions and tokens', () => {
    const view = humanizeFileView('Assets/Textures/OLD_BRICK_WALL.PNG')
    expect(view.typeLabel).toBe('图片素材')
    expect(view.title).toBe('砖墙贴图（旧）')
    expect(view.role).toBe('input')
  })

  it('builds a translated breadcrumb and keeps unknown directories raw', () => {
    expect(humanizeFileView('assets/textures/old_brick_wall.png').pathBreadcrumb).toBe(
      '项目 / 素材 / 贴图 / 砖墙贴图（旧）'
    )
    expect(humanizeFileView('my_folder/brick_wall.png').pathBreadcrumb).toBe(
      '项目 / my_folder / 砖墙贴图'
    )
  })

  it('uses projectName as the breadcrumb root when provided', () => {
    const view = humanizeFileView('assets/textures/old_brick_wall.png', {
      projectName: '  我的工程  '
    })
    expect(view.pathBreadcrumb).toBe('我的工程 / 素材 / 贴图 / 砖墙贴图（旧）')
  })

  it('tolerates empty and whitespace-only paths', () => {
    for (const path of ['', '   ', '/', './']) {
      const view = humanizeFileView(path)
      expect(view.title).toBe(UNKNOWN_ENGLISH_TITLE)
      expect(view.role).toBe('unknown')
      expect(view.typeLabel).toBe('普通文件')
      expect(view.confidence).toBe('low')
      expect(view.pathBreadcrumb).toBe('项目')
    }
  })

  it('keeps a Chinese file name readable and only appends the missing noun', () => {
    const view = humanizeFileView('素材/砖墙.png')
    expect(view.title).toBe('砖墙贴图')
    expect(view.typeLabel).toBe('图片素材')
    expect(view.confidence).toBe('high')

    const config = humanizeFileView('configs/流程配置.json')
    expect(config.title).toBe('流程配置')
    expect(config.typeLabel).toBe('配置文件')
  })
})

describe('roles, icons and confidence', () => {
  it('infers roles from the same directory/extension rules as the scanner', () => {
    expect(humanizeFileView('configs/pipeline.json').role).toBe('config')
    expect(humanizeFileView('scripts/preprocess.py').role).toBe('source')
    expect(humanizeFileView('assets/textures/a.png').role).toBe('input')
    expect(humanizeFileView('output/preview.json').role).toBe('output')
    expect(humanizeFileView('cache/model.tmp').role).toBe('cache')
    expect(humanizeFileView('src/app.ts').role).toBe('source')
  })

  it('lets callers pass the scanner role and it wins over inference', () => {
    const view = humanizeFileView('assets/textures/old_brick_wall.png', { role: 'output' })
    expect(view.role).toBe('output')
    expect(view.roleLabel).toBe('结果')
    expect(view.typeLabel).toBe('结果文件')
    expect(view.explanation).toContain('结果')
  })

  it('maps every role to a Chinese label (C3)', () => {
    expect(HUMAN_ROLE_LABELS).toEqual({
      config: '配置',
      source: '代码',
      input: '素材',
      cache: '缓存',
      output: '结果',
      unknown: '普通文件'
    })
  })

  it('uses semantic icon names, not emoji', () => {
    expect(humanizeFileView('assets/textures/a.png').icon).toBe('image')
    expect(humanizeFileView('configs/pipeline.json').icon).toBe('settings')
    expect(humanizeFileView('scripts/preprocess.py').icon).toBe('code')
    expect(humanizeFileView('output/result.json').icon).toBe('sparkles')
    expect(humanizeFileView('cache/a.tmp').icon).toBe('archive')
    expect(humanizeFileView('unknown.xyz').icon).toBe('file')
  })

  it('marks high / medium / low confidence honestly', () => {
    expect(humanizeFileView('assets/textures/brick_wall.png').confidence).toBe('high')
    expect(humanizeFileView('assets/textures/fdgfdg.png').confidence).toBe('medium')
    expect(humanizeFileView('mystery.zzz').confidence).toBe('low')
  })
})

describe('plain-language explanation', () => {
  it('describes what the file is used for, per role', () => {
    expect(humanizeFileView('assets/textures/old_brick_wall.png').explanation).toContain('图片')
    expect(humanizeFileView('configs/pipeline.json').explanation).toContain('配置')
    expect(humanizeFileView('scripts/preprocess.py').explanation).toContain('脚本')
    expect(humanizeFileView('output/preview.json').explanation).toContain('结果')
    expect(humanizeFileView('cache/model.tmp').explanation).toContain('缓存')
  })

  it('is deterministic for the same input', () => {
    const first = humanizeFileView('assets/textures/old_brick_wall.png')
    const second = humanizeFileView('assets/textures/old_brick_wall.png')
    expect(second).toEqual(first)
  })
})

describe('candidate reason evidence', () => {
  it('only states evidence the scanner actually provides', () => {
    expect(candidateReasonEvidence('same-name')).toContain('文件名完全相同')
    expect(candidateReasonEvidence('similar-name')).toContain('文件名很像')
    expect(candidateReasonEvidence('same-folder')).toContain('同一个文件夹')
    // Never claim unsupported evidence such as identical size/hash.
    for (const reason of ['same-name', 'similar-name', 'same-folder'] as const) {
      const text = candidateReasonEvidence(reason)
      expect(text).not.toContain('大小相同')
      expect(text).not.toContain('哈希')
      expect(text.length).toBeGreaterThan(0)
    }
  })
})

/* ================================================================== */
/* 2.1.2 · software file explanation layer                            */
/* ================================================================== */

const SOFTWARE_SAMPLE = {
  icon: 'assets/icon-ms-accounts.svg',
  manifest:
    'Application/1.60.3200.327/resources/offline-pack/main/cards/ordering-tea/manifest.json',
  pak: '1.60.3200.327/resources/chrome_100_percent.pak',
  mypy: 'mypy.ini',
  hashed:
    'Application/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.bin'
} as const

describe('2.1.2 software file view — realistic installed-software paths', () => {
  it('explains assets/icon-ms-accounts.svg in plain Chinese', () => {
    const view = humanizeSoftwareFile(SOFTWARE_SAMPLE.icon)
    expect(view.typeLabel).toBe('矢量图素材')
    expect(view.title).toBe('微软账户图标')
    expect(view.locationLabel).toBe('素材')
    // “ms” is a shorthand guess, so the confidence stays honest.
    expect(view.confidence).toBe('medium')
    expect(view.whatItIs).toContain('.svg')
    expect(view.whatItIs).toContain('矢量图')
    expect(view.whatFor).toContain('界面')
    expect(CHINESE_PATTERN.test(view.whatItIs)).toBe(true)
    expect(CHINESE_PATTERN.test(view.whatFor)).toBe(true)
  })

  it('explains an offline-pack manifest.json together with its version directory', () => {
    const view = humanizeSoftwareFile(SOFTWARE_SAMPLE.manifest)
    expect(view.typeLabel).toBe('配置数据')
    expect(view.title).toBe('卡片清单配置')
    expect(view.locationLabel).toBe(
      '应用目录 / 版本目录 / 资源目录 / 离线资源包 / 主程序资源 / 卡片 / ordering-tea'
    )
    expect(view.confidence).toBe('high')
    expect(view.whatItIs).toContain('.json')
    expect(view.whatItIs).toContain('配置')
    expect(view.whatFor).toContain('配置')
    expect(view.whatFor).toContain('缺失')
  })

  it('explains a chromium resource pack without overclaiming', () => {
    const view = humanizeSoftwareFile(SOFTWARE_SAMPLE.pak)
    expect(view.typeLabel).toBe('资源包')
    expect(view.title).toBe('浏览器内核资源包（100% 缩放）')
    expect(view.locationLabel).toBe('版本目录 / 资源目录')
    expect(view.confidence).toBe('medium')
    expect(view.whatItIs).toContain('.pak')
    expect(view.whatItIs).toContain('资源包')
    expect(view.whatFor).toContain('资源')
  })

  it('keeps a known tool name readable instead of pretending to translate it', () => {
    const view = humanizeSoftwareFile(SOFTWARE_SAMPLE.mypy)
    expect(view.typeLabel).toBe('配置数据')
    expect(view.title).toBe('mypy 配置')
    expect(view.locationLabel).toBe('软件安装目录')
    expect(view.confidence).toBe('medium')
    expect(view.whatItIs).toContain('.ini')
    expect(view.whatItIs).toContain('配置')
    expect(view.whatFor).toContain('配置')
  })

  it('stays honest for an unknown hashed file name', () => {
    const view = humanizeSoftwareFile(SOFTWARE_SAMPLE.hashed)
    expect(view.title).toBe(UNKNOWN_ENGLISH_TITLE)
    expect(view.typeLabel).toBe('二进制数据')
    expect(view.locationLabel).toBe('应用目录')
    expect(view.confidence).toBe('low')
    expect(view.whatItIs).toContain('无法识别')
    expect(view.whatItIs).toContain('.bin')
    expect(view.whatFor).toContain('静态检查无法确定具体用途')
  })

  it('is deterministic for the same input', () => {
    expect(humanizeSoftwareFile(SOFTWARE_SAMPLE.manifest)).toEqual(
      humanizeSoftwareFile(SOFTWARE_SAMPLE.manifest)
    )
  })
})

describe('2.1.2 extension → typeLabel mapping', () => {
  const TYPE_LABEL_CASES: Array<[string, string]> = [
    ['assets/a.svg', '矢量图素材'],
    ['assets/a.ico', '图标素材'],
    ['assets/a.png', '图片素材'],
    ['assets/a.gif', '动图素材'],
    ['fonts/a.woff2', '字体文件'],
    ['runtime/a.dll', '运行库'],
    ['app.exe', '程序'],
    ['config/a.json', '配置数据'],
    ['config/mypy.ini', '配置数据'],
    ['resources/chrome_100_percent.pak', '资源包'],
    ['docs/manual.docx', 'Word 文档'],
    ['scripts/run.ps1', 'PowerShell 脚本'],
    ['scripts/run.py', 'Python 脚本'],
    ['scripts/app.js', 'JavaScript 脚本'],
    ['maps/city.tmj', '游戏地图数据'],
    ['data/blob.bin', '二进制数据'],
    ['mystery.xyz', '未知类型文件']
  ]

  for (const [path, expected] of TYPE_LABEL_CASES) {
    it(`labels ${path} as ${expected}`, () => {
      expect(humanizeSoftwareFile(path).typeLabel).toBe(expected)
    })
  }
})

describe('2.1.2 expanded dictionaries and locations', () => {
  it('translates installed-software directories and version-like directories', () => {
    const view = humanizeSoftwareFile(
      '1.60.3200.327/resources/offline-pack/main/cards/report.json'
    )
    expect(view.locationLabel).toBe('版本目录 / 资源目录 / 离线资源包 / 主程序资源 / 卡片')
    expect(view.title).toBe('报告配置')
  })

  it('keeps hash-like directory segments raw instead of inventing a label', () => {
    const view = humanizeSoftwareFile(
      'assets/9f86d081884c7d659a2feaa0c55ad015/assets/icon-account.svg'
    )
    expect(view.locationLabel).toContain('9f86d081884c7d659a2feaa0c55ad015')
    expect(view.locationLabel).toContain('素材')
    expect(view.title).toBe('账户图标')
  })

  it('translates the new installed-software file-name tokens', () => {
    expect(humanizeSoftwareFile('assets/app-icon.svg').title).toBe('应用图标')
    expect(humanizeSoftwareFile('assets/account-icon.svg').title).toBe('账户图标')
    expect(humanizeSoftwareFile('workbench/card-report.json').title).toBe('卡片报告配置')
  })

  it('uses projectName for the root location when there are no directories', () => {
    expect(
      humanizeSoftwareFile('mypy.ini', { projectName: '  我的软件  ' }).locationLabel
    ).toBe('我的软件 安装目录')
  })

  it('feeds the expanded directory labels into the C7 breadcrumb too', () => {
    const view = humanizeFileView('resources/offline-pack/main/cards/app.json')
    expect(view.pathBreadcrumb).toBe('项目 / 资源 / 离线资源包 / 主程序资源 / 卡片 / 应用配置')
  })

  it('keeps an already-Chinese file name readable', () => {
    const view = humanizeSoftwareFile('assets/账户图标.svg')
    expect(view.title).toContain('账户')
    expect(view.typeLabel).toBe('矢量图素材')
  })

  it('tolerates empty and odd paths', () => {
    for (const path of ['', '   ', '/', './']) {
      const view = humanizeSoftwareFile(path)
      expect(view.title).toBe(UNKNOWN_ENGLISH_TITLE)
      expect(view.typeLabel).toBe('未知类型文件')
      expect(view.locationLabel).toBe('软件安装目录')
      expect(view.confidence).toBe('low')
      expect(view.whatItIs.length).toBeGreaterThan(0)
      expect(view.whatFor.length).toBeGreaterThan(0)
    }
  })
})

describe('2.1.2 whatItIs / whatFor always stay plain Chinese', () => {
  const PATHS = [
    'assets/icon-ms-accounts.svg',
    'config/app.json',
    'runtime/msvcp140.dll',
    'docs/readme.md',
    'scripts/install.ps1',
    'data/report.csv',
    'unknown/qwerty.xyz',
    SOFTWARE_SAMPLE.hashed
  ]

  for (const path of PATHS) {
    it(`explains ${path} with two non-empty Chinese sentences`, () => {
      const view = humanizeSoftwareFile(path)
      for (const text of [view.whatItIs, view.whatFor, view.locationLabel, view.typeLabel, view.title]) {
        expect(typeof text).toBe('string')
        expect(text.length).toBeGreaterThan(0)
        expect(text).not.toContain('undefined')
      }
      expect(CHINESE_PATTERN.test(view.whatItIs)).toBe(true)
      expect(CHINESE_PATTERN.test(view.whatFor)).toBe(true)
    })
  }
})

describe('2.1.2 unknown English words are never fabricated', () => {
  it('does not translate an unknown word even when the type is known', () => {
    const view = humanizeSoftwareFile('assets/qwerty.svg')
    expect(view.title).toBe(UNKNOWN_ENGLISH_TITLE)
    expect(view.title).not.toContain('qwerty')
    expect(view.typeLabel).toBe('矢量图素材')
    expect(view.whatItIs).toContain('无法识别')
    expect(view.whatFor.length).toBeGreaterThan(0)
    expect(view.confidence).toBe('medium')
  })

  it('falls back when only some tokens are known', () => {
    const view = humanizeSoftwareFile('assets/brick_xyzzy_wall.png')
    expect(view.title).toBe(UNKNOWN_ENGLISH_TITLE)
    // Known prefix must not leak a half-invented translation into the title.
    expect(view.title).not.toContain('砖')
  })
})

describe('2.1.2 reference usage explanation', () => {
  const RULE_USAGE_CASES: Array<{
    ruleName: string
    ruleCategory: RuleCategory
    context: string
    expectWord: string
  }> = [
    {
      ruleName: '配置路径字段',
      ruleCategory: 'config',
      context: '  model_path: "assets/a.ckpt"',
      expectWord: '配置'
    },
    {
      ruleName: '配置路径字段（无引号）',
      ruleCategory: 'config',
      context: 'model: assets/old.ckpt',
      expectWord: '没有引号'
    },
    {
      ruleName: 'AI 工作流字段',
      ruleCategory: 'workflow',
      context: '"ckpt_name": "x.safetensors"',
      expectWord: '工作流'
    },
    {
      ruleName: 'Markdown 图片与链接',
      ruleCategory: 'markdown',
      context: '![图](assets/a.png)',
      expectWord: '图片'
    },
    {
      ruleName: 'Markdown 图片与链接',
      ruleCategory: 'markdown',
      context: '[文档](docs/a.md)',
      expectWord: '链接'
    },
    {
      ruleName: 'HTML / Vue / React 资源属性',
      ruleCategory: 'web',
      context: '<img src="assets/a.png">',
      expectWord: '界面'
    },
    {
      ruleName: 'CSS url() 资源',
      ruleCategory: 'web',
      context: 'background: url(theme/bg.png)',
      expectWord: '样式'
    },
    {
      ruleName: '代码 import / require 路径',
      ruleCategory: 'code',
      context: "require('./lib/a.js')",
      expectWord: '模块'
    },
    {
      ruleName: '代码文件读写调用',
      ruleCategory: 'code',
      context: "open('data/a.csv')",
      expectWord: '读取'
    },
    {
      ruleName: '普通文本中的裸路径',
      ruleCategory: 'text',
      context: 'see assets/a.png in the log',
      expectWord: '静态检查'
    }
  ]

  for (const sample of RULE_USAGE_CASES) {
    it(`explains 「${sample.ruleName}」 (${sample.context}) in plain Chinese`, () => {
      const usage = humanizeReferenceUsage(sample)
      expect(typeof usage).toBe('string')
      expect(usage.length).toBeGreaterThan(0)
      expect(usage).toContain(sample.ruleName)
      expect(usage).toContain(sample.expectWord)
      expect(CHINESE_PATTERN.test(usage)).toBe(true)
    })
  }

  it('falls back to the rule category for custom / unknown rule names', () => {
    const configUsage = humanizeReferenceUsage({
      ruleName: '我的自定义规则',
      ruleCategory: 'config',
      context: 'a = "b"'
    })
    expect(configUsage).toContain('我的自定义规则')
    expect(configUsage).toContain('配置')

    const textUsage = humanizeReferenceUsage({
      ruleName: '我的自定义规则',
      ruleCategory: 'text',
      context: 'a = "b"'
    })
    expect(textUsage).toContain('静态检查')
  })

  it('never throws on empty input, and is deterministic', () => {
    const usage = humanizeReferenceUsage({ ruleName: '', ruleCategory: 'custom', context: '' })
    expect(usage.length).toBeGreaterThan(0)
    expect(CHINESE_PATTERN.test(usage)).toBe(true)
    const sample = {
      ruleName: '配置路径字段',
      ruleCategory: 'config' as RuleCategory,
      context: 'a: "b.json"'
    }
    expect(humanizeReferenceUsage(sample)).toBe(humanizeReferenceUsage(sample))
  })
})

describe('2.1.2 missing-file reasons and honesty notes', () => {
  it('explains why a static check cannot find the file', () => {
    const text = humanizeMissingReason(false)
    expect(text).toContain('没找到')
    expect(text).toContain('静态检查')
    expect(text).toContain('没有找到可能的替代文件')
    expect(text).not.toContain('下面列出的这些文件')
    expect(text).not.toContain('不会复制或删除')
    expect(CHINESE_PATTERN.test(text)).toBe(true)
  })

  it('adds the candidate hint when candidates exist', () => {
    const text = humanizeMissingReason(true)
    expect(text).toContain('可能是同一份文件的其他位置')
    expect(text).toContain('核对')
    expect(text).not.toContain('没有找到可能的替代文件')
    expect(text).not.toBe(humanizeMissingReason(false))
  })

  it('keeps the global honesty notes honest', () => {
    for (const text of [STATIC_CHECK_LIMIT_NOTE, IF_IGNORED_WITHOUT_CANDIDATES]) {
      expect(text.length).toBeGreaterThan(0)
      expect(CHINESE_PATTERN.test(text)).toBe(true)
      expect(text).not.toContain('保证')
      expect(text).not.toContain('一定')
    }
    expect(STATIC_CHECK_LIMIT_NOTE).toContain('不会运行软件')
    expect(IF_IGNORED_WITHOUT_CANDIDATES).toContain('静态检查无法确认')
    expect(IF_IGNORED_WITHOUT_CANDIDATES).toContain('备份')
  })
})

describe('2.1.2 candidate explanations', () => {
  it('explains every scanner-provided candidate reason without overclaiming', () => {
    const expectedWords: Record<DependencyCandidateReason, string> = {
      'same-name': '同一份文件的另一份副本',
      'similar-name': '改过名',
      'same-folder': '同一个文件夹'
    }
    for (const reason of ['same-name', 'similar-name', 'same-folder'] as const) {
      const text = humanizeCandidateExplanation(reason)
      expect(text).toContain(expectedWords[reason])
      expect(text).toContain('不会复制或删除文件')
      expect(text).not.toContain('一定')
      expect(text).not.toContain('保证')
      expect(text).not.toContain('哈希')
      expect(text).not.toContain('大小相同')
      expect(CHINESE_PATTERN.test(text)).toBe(true)
      expect(humanizeCandidateExplanation(reason)).toBe(text)
    }
  })
})

describe('2.1.2 does not change the C7 acceptance behavior', () => {
  it('keeps the exact C7 summary for the reference sample', () => {
    const view = humanizeFileView('assets/textures/old_brick_wall.png')
    expect(formatHumanFileSummary(view)).toBe('图片素材 ·「砖墙贴图（旧）」')
    expect(view.pathBreadcrumb).toBe('项目 / 素材 / 贴图 / 砖墙贴图（旧）')
    expect(candidateReasonEvidence('same-name')).toContain('文件名完全相同')
  })
})
