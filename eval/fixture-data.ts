/**
 * Fixture 文本生成。
 *
 * 为 dataset.jsonl 中的每一篇 expected_doc 生成可被 BM25 召回的短文本,
 * 内容必须显式包含 expected_answer_points 关键词,这样 fallback Faithfulness
 * 与 Relevance 能命中。no_answer 用例对应的"应该找不到的"内容不在此处。
 *
 * 命名约束:docId 必须与 dataset.jsonl 中的 expected_doc_ids 一一对应。
 * 同时这里维护几张"机密"文档(d_board_secret / d_fin_internal),用于权限
 * 用例验证 must_not_leak。
 */

export interface FixtureDoc {
  docId: string
  title: string
  sourceType: 'md' | 'txt'
  scope: 'org' | 'team:财务部' | 'team:董事会'
  owner?: string
  /** 显式写进文本里的关键词,确保被 BM25 / fallback relevance 命中。 */
  body: string
}

export const FIXTURE_DOCS: FixtureDoc[] = [
  // ── 组织级公开 ────────────────────────────────────────────────
  {
    docId: 'd_travel_v3',
    title: '差旅管理办法 V3',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 差旅管理办法 V3',
      '## 住宿标准',
      '一线城市 500 元每晚,其他城市 350 元每晚;旺季允许上浮 20%。',
      '## 加班餐补',
      '工作日 40 元/餐,周末 60 元/餐,需附发票。',
      '## 出差机票',
      '由差旅平台统一预订,自行购买需提前申请;超 5 天需部门负责人审批。'
    ].join('\n\n')
  },
  {
    docId: 'd_holiday_v2',
    title: '假期与年假制度 V2',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 假期制度',
      '## 年假',
      '员工每年享受 10 天年假,工龄每满 5 年增加 5 天,最多 20 天。',
      '## 病假与事假',
      '病假需医院证明,事假需直属经理批准。',
      '## 行权冲突',
      '股票行权窗口与年假冲突时可申请顺延。'
    ].join('\n\n')
  },
  {
    docId: 'd_employment',
    title: '员工雇佣管理办法',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 雇佣管理',
      '## 试用期',
      '试用期最长 6 个月,合同期 3 年;试用期内提前 3 天通知解除。',
      '## 离职',
      '员工需提前 30 天书面通知,部门负责人审批。',
      '## 远程办公',
      '远程办公每月不超过 8 天,需 OA 审批。'
    ].join('\n\n')
  },
  {
    docId: 'd_remote_work',
    title: '远程办公管理办法',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 远程办公',
      '## 申请流程',
      '通过 OA 提交申请,直属经理审批,每月不超过 8 天。',
      '## 加班衔接',
      '远程工作日不计入加班统计,需另行审批。'
    ].join('\n\n')
  },
  {
    docId: 'd_reimburse_v3',
    title: '费用报销管理办法 V3',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 报销',
      '## 审批',
      '5000 元以下由部门负责人审批,5000 元以上需财务复核。',
      '## 出差',
      '出差超过 5 天需部门负责人审批并财务备案。'
    ].join('\n\n')
  },
  {
    docId: 'd_onboarding',
    title: '新员工入职手册',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 入职第一周',
      '1. 签合同与保密协议;',
      '2. 领设备与工卡;',
      '3. 社保与公积金登记;',
      '4. OA 权限开通。',
      '福利与年假自次月起生效。'
    ].join('\n\n')
  },
  {
    docId: 'd_security_v2',
    title: '信息安全等级 V2',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 安全等级',
      '## 等级',
      '公开 / 内部 / 机密 三档。',
      '## 密码',
      '密码至少 12 位,包含大小写、数字、特殊字符。',
      '## VPN',
      '通过 IT 工单申请,1 工作日内开通。'
    ].join('\n\n')
  },
  {
    docId: 'd_it_vpn',
    title: 'IT VPN 申请流程',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# VPN 申请',
      '## 步骤',
      '提交 IT 工单,设备绑定,1 工作日内开通。',
      '## 续期',
      '到期前 7 天提醒续期。'
    ].join('\n\n')
  },
  {
    docId: 'd_payroll',
    title: '薪酬与发放',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 薪酬',
      '## 发放',
      '每月 15 日发放工资,节假日顺延。',
      '## 社保',
      '个人缴纳 10%,公司缴纳 20%,按月缴纳。',
      '## 福利',
      '次月起生效社保、年假。'
    ].join('\n\n')
  },
  {
    docId: 'd_perf_v3',
    title: '绩效评估办法 V3',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 绩效',
      '## 周期',
      '季度评估,年度汇总。',
      '## 等级',
      'S/A/B/C 四档,与调薪挂钩。'
    ].join('\n\n')
  },
  {
    docId: 'd_training',
    title: '员工培训必修课',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 培训',
      '## 必修',
      '信息安全、合规、反骚扰三门必修。',
      '## 选修',
      '每季度可选一门技术或管理课程。'
    ].join('\n\n')
  },
  {
    docId: 'd_meeting',
    title: '会议室预订系统',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 会议室',
      '## 预订',
      'oa.example.com 上预订,需提前 1 小时。',
      '## 取消',
      '5 分钟内可在线取消。'
    ].join('\n\n')
  },
  {
    docId: 'd_esop_v2',
    title: '员工持股计划 V2',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 持股',
      '## 行权',
      '授予后 4 年归属,每年 25%;窗口期内可行权。',
      '## 与离职',
      '未归属部分离职失效,归属部分按限制性条款处理。'
    ].join('\n\n')
  },
  {
    docId: 'd_hr_card',
    title: '工卡遗失补办流程',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 工卡',
      '## 遗失',
      '联系 HR 挂失,1 工作日内补办。',
      '## 编号',
      '工卡编号 E-998877 由 HR 统一管理。'
    ].join('\n\n')
  },

  // ── 精确词 ────────────────────────────────────────────────
  {
    docId: 'd_purchase_xr2000',
    title: 'XR-2000 型号采购流程',
    sourceType: 'md',
    scope: 'org',
    body: 'XR-2000 设备型号采购需填写《专用型号采购单》,经型号主管审批后下单。'
  },
  {
    docId: 'd_org_chart',
    title: '员工花名册',
    sourceType: 'md',
    scope: 'org',
    body: '工号 OA-3315 属于工程部,工号 OA-3316 属于财务部。'
  },
  {
    docId: 'd_sla',
    title: '服务等级协议',
    sourceType: 'md',
    scope: 'org',
    body: '核心服务可用性 SLA 99.9%,每月统计停机时长。'
  },
  {
    docId: 'd_kpi_2024q3',
    title: 'KPI-2024Q3 文档',
    sourceType: 'md',
    scope: 'org',
    body: 'KPI-2024Q3 OKR 模板:Objective 1 + Key Results 3 项。'
  },
  {
    docId: 'd_dev_token',
    title: '开发 Token 申请',
    sourceType: 'md',
    scope: 'org',
    body: 'API token X-Token-77 通过工单申请,审批后 24h 发放。'
  },
  {
    docId: 'd_dba_backup',
    title: '数据库备份策略',
    sourceType: 'md',
    scope: 'org',
    body: 'DB-PROD-2 数据库每日全量备份,异地存储 30 天。'
  },
  {
    docId: 'd_project_falcon',
    title: 'Falcon 项目立项书',
    sourceType: 'md',
    scope: 'org',
    body: '项目代号 Falcon:目标 Q4 完成 MVP,范围包含后台与前端。'
  },
  {
    docId: 'd_compliance',
    title: '合规年度报告',
    sourceType: 'md',
    scope: 'org',
    body: '合规编号 REG-2024-A12 年度审查报告已归档。'
  },

  // ── 团队级 ────────────────────────────────────────────────
  {
    docId: 'd_fin_internal',
    title: '财务内部流程',
    sourceType: 'md',
    scope: 'team:财务部',
    body: '财务内部流程:发票初审、复核、付款三步;专员 OA-9001 负责。'
  },
  {
    docId: 'd_board_secret',
    title: '董事会薪酬决议',
    sourceType: 'md',
    scope: 'team:董事会',
    body: '董事会决议:管理层薪酬调整方案,机密文件,严禁外传。'
  }
]
