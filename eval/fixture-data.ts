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
      '试用期员工的年假按实际工龄折算。',
      '## 行权冲突',
      '股票行权窗口与年假冲突时可申报并申请顺延。'
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
      '远程工作日不计入加班统计,需另行审批；每月远程办公上限 8 天。'
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
      '4. OA 权限开通;',
      '5. 工资银行卡登记。',
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
      '机密资料只能由具备内部权限的员工查阅。',
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
      '在 vpn.example.com 提交 IT 申请单和工单,设备绑定,1 工作日内开通。',
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
  },

  // ── 新增组织级(覆盖 fact / multi_hop) ──────────────────────
  {
    docId: 'd_assets_v1',
    title: '公司资产管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 资产管理',
      '## 编号',
      '公司资产统一编号 AS-2024-001 系列,部门领用登记。',
      '## 折旧',
      '电子设备按 3 年折旧,办公家具按 5 年折旧。',
      '## 报废',
      '资产报废由部门负责人审批,IT 复核。'
    ].join('\n\n')
  },
  {
    docId: 'd_recruit_v1',
    title: '招聘管理办法',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 招聘',
      '## 流程',
      '用人部门提需求,HR 筛选,部门负责人面试,HR 终面。',
      '## 渠道',
      '内部推荐、外部招聘网站、猎头三种渠道。',
      '## 试用期',
      '新员工试用期 3-6 个月,详见雇佣管理办法。'
    ].join('\n\n')
  },
  {
    docId: 'd_overtime_v2',
    title: '加班细则 V2',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 加班',
      '## 申请',
      '加班需提前 OA 申请,直属经理审批。',
      '## 调休',
      '工作日加班可换调休,周末加班按 1.5 倍换算。',
      '## 限额',
      '每月加班不超过 36 小时。'
    ].join('\n\n')
  },
  {
    docId: 'd_mobile_use',
    title: '手机使用规范',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 手机使用',
      '## 报销',
      '工作手机话费每月 100 元额度内可报销,需发票。',
      '## 配备',
      '销售岗位统一配发工作手机。'
    ].join('\n\n')
  },
  {
    docId: 'd_visitor_v1',
    title: '访客管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 访客',
      '## 登记',
      '访客需前台登记,出示身份证件,领取访客卡。',
      '## 陪同',
      '全程由员工陪同,不得进入保密区域。'
    ].join('\n\n')
  },
  {
    docId: 'd_wifi_v1',
    title: 'WiFi 使用规范',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# WiFi',
      '## 内网',
      '员工使用 EchoCorp 内部 SSID,设备绑定。',
      '## 访客',
      '访客使用 EchoGuest 网络,带宽受限。'
    ].join('\n\n')
  },
  {
    docId: 'd_gift_v1',
    title: '礼品接收规范',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 礼品',
      '## 申报',
      '价值超过 200 元的礼品需主动申报,登记到合规系统。',
      '## 上交',
      '敏感岗位礼品由合规部门统一处理。'
    ].join('\n\n')
  },
  {
    docId: 'd_meal_v1',
    title: '工作餐管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 工作餐',
      '## 加班餐',
      '工作日晚加班 8 点后提供免费工作餐,标准 40 元。',
      '## 团建餐',
      '部门团建聚餐每月上限 200 元/人。'
    ].join('\n\n')
  },
  {
    docId: 'd_health_v1',
    title: '健康体检',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 体检',
      '## 年度',
      '公司在职员工每年免费体检一次,40 岁以上加做心血管项目。',
      '## 预约',
      '通过 HR 系统预约,体检机构指定名单内。'
    ].join('\n\n')
  },
  {
    docId: 'd_relocation',
    title: '异地调动管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 异地调动',
      '## 申请',
      '员工主动申请或公司安排,需双方确认。',
      '## 补贴',
      '提供一次性搬家补贴 5000 元,住房补贴 3 个月。'
    ].join('\n\n')
  },
  {
    docId: 'd_parking_v1',
    title: '停车管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 停车',
      '## 车位',
      '地下车库优先配给新能源车,按车牌登记。',
      '## 收费',
      '地面车位每月 200 元,内部员工半价。'
    ].join('\n\n')
  },
  {
    docId: 'd_grievance_v1',
    title: '员工申诉流程',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 申诉',
      '## 渠道',
      '员工对处分、绩效等有异议可向 HR 申诉,匿名渠道开放。',
      '## 处理',
      '申诉 7 个工作日内书面回复,涉重大事项升级到独立委员会。'
    ].join('\n\n')
  },
  {
    docId: 'd_archive_v1',
    title: '档案管理办法',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 档案',
      '## 员工档案',
      '员工档案由 HR 统一保管,查阅需授权。',
      '## 保存',
      '离职档案保存 5 年,合规档案保存 10 年。'
    ].join('\n\n')
  },
  {
    docId: 'd_notary_v1',
    title: '公章管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 公章',
      '## 保管',
      '公司公章由行政部专人保管,使用登记。',
      '## 流程',
      '用印需 OA 审批,法定代表人签字或授权。'
    ].join('\n\n')
  },
  {
    docId: 'd_vehicle_v1',
    title: '公务用车',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 公务用车',
      '## 申请',
      '通过 OA 申请,行政部统一调度。',
      '## 油费',
      '公务出行油费实报实销,需加油小票。'
    ].join('\n\n')
  },
  {
    docId: 'd_office_v1',
    title: '办公环境',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 办公环境',
      '## 温度',
      '夏季空调不低于 26 度,冬季不高于 22 度。',
      '## 清洁',
      '每周一次深度清洁,工位由员工自行整理。'
    ].join('\n\n')
  },
  {
    docId: 'd_attendance',
    title: '考勤管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 考勤',
      '## 时间',
      '工作时间为工作日 9:00-18:00,午休 1 小时,弹性半小时。',
      '## 打卡',
      '通过 OA 打卡,迟到 30 分钟内不扣款。'
    ].join('\n\n')
  },
  {
    docId: 'd_dress_code',
    title: '着装规范',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 着装',
      '## 日常',
      '日常工作日商务休闲,周五可休闲装。',
      '## 客户',
      '接待客户或重要会议需正装。'
    ].join('\n\n')
  },
  {
    docId: 'd_library',
    title: '图书角管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 图书角',
      '## 借阅',
      '员工可免费借阅,每次最多 2 本,期限 30 天。',
      '## 捐书',
      '欢迎员工捐赠专业或人文类图书。'
    ].join('\n\n')
  },
  {
    docId: 'd_team_event',
    title: '团建管理',
    sourceType: 'md',
    scope: 'org',
    body: [
      '# 团建',
      '## 频次',
      '部门每季度至少 1 次团建,公司年度大型团建 1 次。',
      '## 预算',
      '团建预算每月人均 300 元,需发票与签到表。'
    ].join('\n\n')
  },

  // ── 新增 exact_term 类 ──────────────────────────────────────
  {
    docId: 'd_purchase_nx500',
    title: 'NX-500 设备采购',
    sourceType: 'md',
    scope: 'org',
    body: 'NX-500 设备型号采购需走专用型号审批,采购单号 PO-NX-2024-088。'
  },
  {
    docId: 'd_employee_bob',
    title: '员工花名册 2024',
    sourceType: 'md',
    scope: 'org',
    body: '工号 OA-7711 属于产品部,工号 OA-7712 属于运营部,工号 OA-7713 属于研发部。'
  },
  {
    docId: 'd_sla_v2',
    title: '服务等级协议 V2',
    sourceType: 'md',
    scope: 'org',
    body: '核心服务 SLA 99.95%,边缘服务 SLA 99.5%,月报统计。'
  },
  {
    docId: 'd_kpi_2025q1',
    title: 'KPI-2025Q1 模板',
    sourceType: 'md',
    scope: 'org',
    body: 'KPI-2025Q1 OKR 模板:Objective 2 + Key Results 5 项,季度自评。'
  },
  {
    docId: 'd_token_y88',
    title: 'API Token Y-88',
    sourceType: 'md',
    scope: 'org',
    body: 'API token Y-88 走加急通道,4h 内发放,需安全审批。'
  },
  {
    docId: 'd_db_prod_5',
    title: '数据库 DB-PROD-5 备份',
    sourceType: 'md',
    scope: 'org',
    body: 'DB-PROD-5 数据库每 6 小时增量备份,异地存储 90 天。'
  },
  {
    docId: 'd_project_eagle',
    title: 'Eagle 项目立项',
    sourceType: 'md',
    scope: 'org',
    body: '项目代号 Eagle 目标 Q2 上线,范围包含移动端与后台。'
  },
  {
    docId: 'd_compliance_2025',
    title: '合规报告 REG-2025-A01',
    sourceType: 'md',
    scope: 'org',
    body: '合规编号 REG-2025-A01 半年度审查,12 月归档。'
  },
  {
    docId: 'd_invoice_v2',
    title: '发票 INV-2025-001',
    sourceType: 'md',
    scope: 'org',
    body: '发票 INV-2025-001 已开具,认证抵扣需 30 天内办理。'
  },
  {
    docId: 'd_lease_v1',
    title: '租约 LEASE-2024',
    sourceType: 'md',
    scope: 'org',
    body: '租约 LEASE-2024-08 续签,主租户财务部,租期 3 年。'
  },
  {
    docId: 'd_supplier_v1',
    title: '供应商 SUP-2024-11',
    sourceType: 'md',
    scope: 'org',
    body: '供应商编号 SUP-2024-11 年度评估合格,准入清单保留。'
  },
  {
    docId: 'd_event_v1',
    title: '活动 EVT-2025-03',
    sourceType: 'md',
    scope: 'org',
    body: '活动 EVT-2025-03 客户日,3 月 15 日举办,场地预订中。'
  },
  {
    docId: 'd_patent_v1',
    title: '专利 PAT-2024-X',
    sourceType: 'md',
    scope: 'org',
    body: '专利编号 PAT-2024-X 已授权,年费缴纳 6 月底前完成。'
  },
  {
    docId: 'd_office_3f',
    title: '办公室 3F',
    sourceType: 'md',
    scope: 'org',
    body: '办公室 3F 由研发部使用,工位 80 个,会议室 4 间。'
  },
  {
    docId: 'd_meeting_room_b',
    title: '会议室 B 预约',
    sourceType: 'md',
    scope: 'org',
    body: '会议室 B 容纳 12 人,预订通过 OA,提前 1 小时。'
  },
  {
    docId: 'd_seat_88',
    title: '工位 SEAT-88',
    sourceType: 'md',
    scope: 'org',
    body: '工位 SEAT-88 位于 3F 靠窗,设备领用登记 OA-2024-88。'
  },
  {
    docId: 'd_voucher_v1',
    title: '凭证 V-2025-001',
    sourceType: 'md',
    scope: 'org',
    body: '凭证编号 V-2025-001 月末结转,保管期 10 年。'
  },
  {
    docId: 'd_payroll_bank',
    title: '工资发放账户',
    sourceType: 'md',
    scope: 'org',
    body: '工资发放账户开户行工商银行,支行代码 102,每月 15 日转账。'
  },
  {
    docId: 'd_insurance_v1',
    title: '保险 INS-2024',
    sourceType: 'md',
    scope: 'org',
    body: '商业保险 INS-2024 年度续保,意外医疗 50 万额度。'
  },
  {
    docId: 'd_legal_v1',
    title: '法务档案',
    sourceType: 'md',
    scope: 'org',
    body: '法务档案 LEG-2024 合同审查记录,涉诉案件 3 起,均结案。'
  }
]
