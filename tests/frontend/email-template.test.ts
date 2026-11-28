/**
 * F11 · 模板库（域层）
 *
 * 这个文件锁四组边界，全部用**反例驱动**——只测「合法路径能过」等于没测：
 *  1. 变量白名单：未知变量必须报错、不许静默留空进正文；
 *  2. 渲染语义：缺变量保留 {{x}} 并如实报出，绝不拿默认值编造事实；
 *  3. 合规边界：模板自带退订尾巴 / 写死发件人身份 / F6-2 禁词 一律判非法
 *     （尾巴与身份由代码注入，模板再写一遍就是双尾巴）；
 *  4. 内置模板必须自己先过校验 —— 防止「出厂即非法」这种最低级错误。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_VARIABLES,
  buildTemplateVars,
  extractTemplateVars,
  materializeTemplate,
  renderTemplate,
  validateTemplate,
} from '@/domain/email-template'
import { validateEmail } from '@/domain/compliance'
import { BANNED_WORDS, EMAIL_PURPOSES } from '@/domain/constants'

/** 一个合法的基准模板，各用例只改一处来验证「改坏哪一处会被拦」 */
const base = {
  name: '基准模板',
  purpose: 'intro',
  subject: '{{product}} supply for {{company}}',
  body: 'We noticed {{anchor}}. We supply {{product}} with {{advantage}} and can share our current catalogue. Would a short specification sheet be useful for your team this quarter?',
}

const issuesOf = (patch: Partial<typeof base>) => validateTemplate({ ...base, ...patch }).issues
const joined = (patch: Partial<typeof base>) => issuesOf(patch).join(' | ')

describe('F11 变量白名单', () => {
  it('白名单固定七个，顺序稳定（新增变量必须同步改文档与 UI）', () => {
    expect(TEMPLATE_VARIABLES).toEqual([
      'company', 'product', 'anchor', 'senderName', 'senderCompany', 'market', 'advantage',
    ])
  })

  it('extractTemplateVars 去重且保序', () => {
    expect(extractTemplateVars('{{company}} / {{product}} / {{company}}')).toEqual(['company', 'product'])
  })

  it('extractTemplateVars 容忍花括号内空白', () => {
    expect(extractTemplateVars('hi {{  company  }}')).toEqual(['company'])
  })

  it('非法标识符形态不会被当成变量（{{.secret}} / {{1abc}}）', () => {
    expect(extractTemplateVars('{{.secret}} {{1abc}}')).toEqual([])
  })
})

describe('F11 渲染：缺值不编造', () => {
  it('缺变量时保留 {{x}} 原文并报 missingVars', () => {
    const r = renderTemplate({ subject: '{{product}} for {{company}}', body: 'hi {{advantage}}' }, { product: 'fittings' })
    expect(r.subject).toBe('fittings for {{company}}')
    expect(r.body).toBe('hi {{advantage}}')
    expect(r.missingVars.sort()).toEqual(['advantage', 'company'])
    expect(r.unknownVars).toEqual([])
  })

  it('空白字符串等同于缺失（trim 后为空不算已填）', () => {
    const r = renderTemplate({ subject: 's', body: '{{company}}' }, { company: '   ' })
    expect(r.body).toBe('{{company}}')
    expect(r.missingVars).toEqual(['company'])
  })

  it('白名单外变量保留原文并报 unknownVars', () => {
    const r = renderTemplate({ subject: 's', body: 'a {{secret}} b' }, {})
    expect(r.body).toBe('a {{secret}} b')
    expect(r.unknownVars).toEqual(['secret'])
    expect(r.missingVars).toEqual([])
  })

  it('替换值里的 $& / $1 不会被当成正则替换语法', () => {
    const r = renderTemplate({ subject: 's', body: '{{company}}' }, { company: 'A $& B $1' })
    expect(r.body).toBe('A $& B $1')
  })

  it('主题渲染结果截断到 200 字符，正文不截断', () => {
    const long = 'x'.repeat(300)
    const r = renderTemplate({ subject: '{{company}}', body: '{{company}}' }, { company: long })
    expect(r.subject).toHaveLength(200)
    expect(r.body).toHaveLength(300)
  })
})

describe('F11 校验：结构', () => {
  it('基准模板通过（基线自证，否则后面所有反例都没意义）', () => {
    expect(validateTemplate(base)).toEqual({ ok: true, issues: [] })
  })

  it('名称为空被拒', () => {
    expect(joined({ name: '   ' })).toContain('模板名称不能为空')
  })

  it('名称超 40 字被拒', () => {
    expect(joined({ name: '名'.repeat(41) })).toContain('模板名称不超过 40 字')
  })

  it('目的不在 EMAIL_PURPOSES 里被拒，并把可选值列出来', () => {
    const s = joined({ purpose: 'spam' })
    expect(s).toContain('目的必须是')
    for (const p of EMAIL_PURPOSES) expect(s).toContain(p.key)
  })

  it('正文短于 40 字符被拒', () => {
    expect(joined({ body: 'too short' })).toContain('正文至少 40 个字符')
  })

  it('正文超 1200 字符被拒', () => {
    expect(joined({ body: `We noticed {{anchor}}. ${'x'.repeat(1200)}` })).toContain('正文不超过 1200 个字符')
  })

  it('主题超 120 字符被拒', () => {
    expect(joined({ subject: 'x'.repeat(121) })).toContain('主题不超过 120 个字符')
  })

  it('花括号不配对被拒（{{company} 这种半截占位符）', () => {
    expect(joined({ body: `${base.body} {{company}` })).toContain('花括号不配对')
  })

  it('白名单外变量被拒，且报错文案列出可用变量', () => {
    const s = joined({ body: `${base.body} {{secret}}` })
    expect(s).toContain('存在不支持的变量：{{secret}}')
    expect(s).toContain('{{company}}')
  })
})

describe('F11 校验：合规红线', () => {
  it('模板自带退订语句被拒（会拼成双尾巴）', () => {
    expect(joined({ body: `${base.body} Reply STOP to unsubscribe.` })).toContain('不得自带退订语句')
  })

  it('中文「退订」同样被拒', () => {
    expect(joined({ body: `${base.body} 回复退订即可。` })).toContain('不得自带退订语句')
  })

  it('模板写死签名块（-- 之后带网站）被拒', () => {
    expect(joined({ body: `${base.body}\n--\nJohn · www.example.com` })).toContain('不得写死发件人身份')
  })

  it('模板写死公司后缀（明文 Ltd / GmbH）被拒', () => {
    expect(joined({ body: `${base.body} Our office is Sample Trading Ltd.` })).toContain('不得写死发件人身份')
  })

  it('但引用 {{company}} / {{senderCompany}} 不算写死身份——客户名常自带 Co., Ltd.', () => {
    // 关键反例：公司名的真实值经常就是「Rhein Hydraulik GmbH」，
    // 若把变量注入的身份也算进去，所有引用公司名的合法模板会被整片误杀。
    const withVars = {
      ...base,
      body: 'Our team at {{senderCompany}} supplies {{product}} to {{company}} in {{market}}, backed by {{advantage}}. We noticed {{anchor}}. Would a short sheet help this quarter?',
    }
    expect(validateTemplate(withVars)).toEqual({ ok: true, issues: [] })
  })

  it('F6-2 禁词被拒，且与服务端共用同一份词表', () => {
    // 不硬编码 "free"：从协议词表取一个真实词，词表变了这条测试自动跟着变
    const word = BANNED_WORDS[0]
    expect(joined({ body: `${base.body} ${word}` })).toContain('正文含 F6-2 禁词')
  })

  it('禁词按词匹配：free 不误伤 freedom', () => {
    expect(validateTemplate({ ...base, body: 'We noticed {{anchor}}. Freedom of specification matters to {{company}}, so we keep {{product}} configurable and share {{advantage}} on request.' }).ok).toBe(true)
  })
})

describe('F11 内置模板', () => {
  it('三个内置模板全部通过自校验（出厂即合法）', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      expect(validateTemplate(tpl), `内置模板「${tpl.name}」不合法`).toEqual({ ok: true, issues: [] })
    }
  })

  it('内置模板不可删除（builtin 标记齐备）', () => {
    expect(DEFAULT_TEMPLATES).toHaveLength(3)
    for (const tpl of DEFAULT_TEMPLATES) expect(tpl.builtin).toBe(true)
  })

  it('id 唯一且都以 tpl_builtin_ 前缀（便于 UI 区分内置与自建）', () => {
    const ids = DEFAULT_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.startsWith('tpl_builtin_')).toBe(true)
  })

  it('内置模板只用白名单变量', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      for (const v of [...extractTemplateVars(tpl.subject), ...extractTemplateVars(tpl.body)]) {
        expect(TEMPLATE_VARIABLES as readonly string[]).toContain(v)
      }
    }
  })

  it('内置模板不带退订尾巴与身份（由代码注入）', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      expect(tpl.body).not.toMatch(/unsubscribe|reply\s+stop|退订/i)
      expect(tpl.body).not.toMatch(/\b(?:GmbH|Ltd|Inc|Co)\b\.?/)
    }
  })

  it('三个 stage 互不重复，覆盖 intro / followup / breakup', () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.stage)).toEqual(['intro', 'followup', 'breakup'])
  })

  it('内置模板用完整变量渲染后不残留占位符', () => {
    const vars = {
      company: 'Rhein Hydraulik', product: 'hydraulic hose fittings', anchor: 'you distribute fittings',
      senderName: 'Kou', senderCompany: 'Gakiwoo', market: 'Germany', advantage: 'short lead times',
    }
    for (const tpl of DEFAULT_TEMPLATES) {
      const r = renderTemplate(tpl, vars)
      expect(r.missingVars).toEqual([])
      expect(r.unknownVars).toEqual([])
      expect(`${r.subject}${r.body}`).not.toContain('{{')
    }
  })
})

describe('F11 materializeTemplate：把洞变成能被拦下的洞', () => {
  const full = {
    company: 'Rhein', product: 'fittings', anchor: 'you distribute fittings',
    senderName: 'Kou', senderCompany: 'Gakiwoo', market: 'Germany', advantage: 'short lead times',
  }

  it('变量齐备时 ready=true，正文里没有任何待填标记', () => {
    const m = materializeTemplate(base, full)
    expect(m.ready).toBe(true)
    expect(m.missingVars).toEqual([])
    expect(m.body).not.toContain('[待填')
    expect(m.body).not.toContain('{{')
  })

  it('缺变量时 ready=false，并把洞转成 [待填：x]', () => {
    const m = materializeTemplate(base, { product: 'fittings' })
    expect(m.ready).toBe(false)
    // base 正文里用到的是 anchor / advantage，subject 里是 company
    expect(m.body).toContain('[待填：anchor]')
    expect(m.body).toContain('[待填：advantage]')
    expect(m.body).not.toContain('{{anchor}}')
    expect(m.subject).toContain('[待填：company]')
    expect(m.missingVars.sort()).toEqual(['advantage', 'anchor', 'company'])
  })

  it('转出来的 [待填：x] 能被 validateEmail 的占位符检查拦住（关键：花括号会漏过去）', () => {
    const m = materializeTemplate(base, { product: 'fittings' })
    // 反证：直接用 renderTemplate 的花括号形态，hasPlaceholder 是 false —— 那封信会被发出去
    const raw = renderTemplate(base, { product: 'fittings' })
    expect(validateEmail(raw.body, { maxWords: 400 }).hasPlaceholder).toBe(false)
    // 正证：materialize 之后必被拦
    expect(validateEmail(m.body, { maxWords: 400 }).hasPlaceholder).toBe(true)
  })
})

describe('F11 buildTemplateVars', () => {
  const profile = {
    mainProducts: 'hydraulic hose fittings, quick couplings, adapters',
    advantages: ['short lead times', 'small MOQ'],
    senderName: 'Kou',
    companyNameEn: 'Gakiwoo Industrial',
  }

  it('product 只取第一个主营产品，不把整串塞进模板', () => {
    const v = buildTemplateVars({ company: { name: 'Rhein Hydraulik GmbH', country: 'Germany' }, profile, anchor: 'you distribute fittings' })
    expect(v.product).toBe('hydraulic hose fittings')
    expect(v.advantage).toBe('short lead times')
    expect(v.company).toBe('Rhein')
    expect(v.market).toBe('Germany')
  })

  it('anchor 压缩空白并截断到 120', () => {
    const v = buildTemplateVars({ company: { name: 'A', country: 'DE' }, profile, anchor: `  you   distribute\n\nfittings ${'x'.repeat(200)}` })
    const anchor = v.anchor ?? ''
    expect(anchor).toHaveLength(120)
    expect(anchor).not.toContain('\n')
    expect(anchor.startsWith('you distribute fittings')).toBe(true)
  })

  it('mainProducts 为空时 product 返回空串（不猜）', () => {
    const v = buildTemplateVars({ company: { name: 'A', country: 'DE' }, profile: { ...profile, mainProducts: '' }, anchor: 'a' })
    expect(v.product).toBe('')
  })

  it('advantages 缺失 / 脏值不崩，advantage 返回空串（历史数据容错）', () => {
    const dirty = { ...profile, advantages: undefined as unknown as string[] }
    const v = buildTemplateVars({ company: { name: 'A', country: 'DE' }, profile: dirty, anchor: 'a' })
    expect(v.advantage).toBe('')
  })

  it('advantages 里的空串被跳过，取第一个非空项', () => {
    const v = buildTemplateVars({ company: { name: 'A', country: 'DE' }, profile: { ...profile, advantages: ['', '  ', 'fast sampling'] }, anchor: 'a' })
    expect(v.advantage).toBe('fast sampling')
  })
})
