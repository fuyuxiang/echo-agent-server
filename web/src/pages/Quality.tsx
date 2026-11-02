import SearchTest from './SearchTest'
import * as ops from '../api/operations'
import { message, Button, Modal, Tabs } from 'antd'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Maintenance } from './Operations'
import { useEffect, useState, useCallback } from 'react'
import {
  Card, Row, Col, Statistic, Table, Segmented, Space, Empty, Alert, Tag, Spin,
} from 'antd'
import * as api from '../api'
import type { QualityOverview } from '../types'
import { fmtPercent, fmtTime } from '../utils/format'

/**
 * 质量看板。
 *
 * 统计的是答案里实际被引用的材料,不是召回量 —— 召回十条只用一条,按召回
 * 统计会高估系统表现。无答案率是最值得盯的单一指标:突然升高通常意味着
 * 摄取出了问题,或者出现了新的知识盲区。
 */
export default function Quality() {
  const [params, setParams] = useSearchParams()
  return <Tabs activeKey={['maintenance','test'].includes(params.get('tab')??'')?params.get('tab')!:'analysis'} onChange={key => setParams(key === 'maintenance' ? { tab: key } : {})} items={[
    { key: 'analysis', label: '质量分析', children: <QualityAnalysis /> },
    { key: 'maintenance', label: '维护清单', children: <Maintenance /> },
    { key:'test',label:'检索验证',children:<SearchTest/> },
  ]} />
}

function QualityAnalysis() {
  const nav=useNavigate()
  const createTask=(question:string)=>Modal.confirm({title:'创建知识维护任务？',content:question,onOk:async()=>{const task=await ops.createMaintenance({question});message.success(task.dedup?'已有未关闭的维护事项，已定位':'已创建维护事项');nav(`/quality?tab=maintenance&taskId=${task.id}`)}})
  const [days, setDays] = useState(30)
  const [data, setData] = useState<QualityOverview | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.getQuality(days))
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { void load() }, [load])

  if (loading && !data) return <Spin />
  if (!data) return <Empty />

  const agenticHigh = data.agenticRate > 0.25
  const unansweredHigh = data.unansweredRate > 0.3

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Segmented
        value={days}
        onChange={(v) => setDays(v as number)}
        options={[
          { label: '近 7 天', value: 7 },
          { label: '近 30 天', value: 30 },
          { label: '近 90 天', value: 90 },
        ]}
      />

      {data.total === 0 && (
        <Alert
          type="info"
          showIcon
          message="暂无问答记录"
          description="员工在客户端提问后,这里会显示答案质量与知识盲区。"
        />
      )}

      <Alert showIcon type="info" message={`已收到 ${data.feedbackCount??0} 次反馈，覆盖 ${(100*(data.feedbackCoverage??0)).toFixed(1)}% 的问答；负面反馈率按已有反馈计算，未反馈不会计为满意。`}/>
      {data.total>0&&data.total<20&&<Alert type="info" showIcon message={`当前仅 ${data.total} 条问答，样本有限，不宜据此评价整体知识质量。`}/>}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="问答总数" value={data.total} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="无答案率"
              value={data.total?fmtPercent(data.unansweredRate):'—'}
              valueStyle={unansweredHigh ? { color: 'var(--echo-error)' } : undefined}
            />
            <div style={{ fontSize: 12, color: 'var(--echo-text-muted)', marginTop: 4 }}>
              {!data.total?'尚无问答样本':data.total<20?'样本较少，仅作观察':unansweredHigh?'偏高，检查知识内容与处理状态':'按实际问答统计'}
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="负面反馈率"
              value={data.feedbackCount?fmtPercent(data.negativeRate):'—'}
              valueStyle={data.negativeRate > 0.15 ? { color: 'var(--echo-error)' } : undefined}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="深度检索占比"
              value={data.total?fmtPercent(data.agenticRate):'—'}
              valueStyle={agenticHigh ? { color: 'var(--echo-warning)' } : undefined}
            />
            <div style={{ fontSize: 12, color: 'var(--echo-text-muted)', marginTop: 4 }}>
              {!data.total?'尚无问答样本':data.total<20?'样本较少，仅作观察':agenticHigh?'深度检索较多，可检查问题复杂度':'按实际检索方式统计'}
            </div>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="检索延迟">
        <Row gutter={[16, 16]}>
          <Col span={8}><Statistic title="平均" value={data.latency.avg ?? '—'} suffix="ms" /></Col>
          <Col span={8}><Statistic title="p50" value={data.latency.p50 ?? '—'} suffix="ms" /></Col>
          <Col span={8}>
            <Statistic
              title="p95"
              value={data.latency.p95 ?? '—'}
              suffix="ms"
              valueStyle={(data.latency.p95 ?? 0) > 800 ? { color: 'var(--echo-error)' } : undefined}
            />
          </Col>
        </Row>
        <div style={{ fontSize: 12, color: 'var(--echo-text-muted)', marginTop: 8 }}>
          p95 目标 ≤ 800ms。超标先看精排是否被跳过(服务端日志会记录降级原因)。
        </div>
      </Card>

      <Card
        size="small"
        title="知识盲区"
        extra={<span style={{ fontSize: 12, color: 'var(--echo-text-muted)' }}>没答上来的问题,可直接作为补充文档的清单</span>}
      >
        <Table
          scroll={{ x: 400 }}
          rowKey="question"
          size="small"
          pagination={false}
          dataSource={data.blindSpots}
          locale={{ emptyText: '暂无' }}
          columns={[
            { title: '问题', dataIndex: 'question' },
            {title:'',width:100,render:(_:unknown,r:{question:string})=><Button type="link" onClick={()=>createTask(r.question)}>创建任务</Button>},
            { title: '被问次数', dataIndex: 'n', width: 100 },
          ]}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card size="small" title="被标记为无用或错误的回答">
            <Table<QualityOverview['negativeTop'][number]>
              scroll={{ x: 440 }}
              rowKey={(r:QualityOverview['negativeTop'][number]) => `${r.question}-${r.createdAt}`}
              size="small"
              pagination={false}
              dataSource={data.negativeTop}
              locale={{ emptyText: '暂无' }}
              columns={[
                { title: '问题', dataIndex: 'question' },
                {
                  title: '反馈',
                  dataIndex: 'feedback',
                  width: 90,
                  render: (f: string) => (
                    <Tag color={f === 'wrong' ? 'red' : 'orange'}>
                      {f === 'wrong' ? '答错了' : '没帮助'}
                    </Tag>
                  ),
                },
                {title:'',width:100,render:(_:unknown,r:{question:string})=><Button type="link" onClick={()=>createTask(r.question)}>创建任务</Button>},
                { title: '时间', dataIndex: 'createdAt', width: 140, render: fmtTime },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            size="small"
            title="当前版本从未被引用（全量历史）"
            extra={<span style={{ fontSize: 12, color: 'var(--echo-text-muted)' }}>结合上线时间与适用范围评估，勿仅据零引用归档</span>}
          >
            <Table
              scroll={{ x: 440 }}
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={data.unusedDocs}
              locale={{ emptyText: '暂无' }}
              columns={[
                { title: '标题', render:(_:unknown,r:any)=><Button type="link" onClick={()=>nav(`/documents?docId=${r.id}`)}>{r.title}</Button> },
                { title: '上传时间', dataIndex: 'createdAt', width: 140, render: fmtTime },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card title="知识贡献与复用" extra={<span className="echo-muted">同一回答引用同一逻辑文档仅计一次</span>}><Table scroll={{x:600}} rowKey="id" dataSource={data.contributions??[]} pagination={{pageSize:10}} columns={[{title:'维护人',render:(_:unknown,r:any)=><Button type="link" onClick={()=>nav(`/users/${r.id}`)}>{r.displayName}</Button>},{title:'当前在库文档',dataIndex:'documents'},{title:'有效经验',dataIndex:'memories'},{title:'已发布技能',dataIndex:'skills'},{title:`近 ${days} 天引用`,dataIndex:'citations'}]}/><p className="echo-muted">贡献量按当前共享知识统计，引用量按所选时间窗口统计；个人知识不参与组织贡献排名。</p></Card>
      <Card size="small" title="文档摄取状态分布">
        <Space wrap>
          {data.docStats.map((s) => (
            <Tag key={s.status} color={s.status === 'failed' ? 'error' : s.status === 'ready' ? 'success' : 'default'}>
              {({ready:'可检索',failed:'处理失败',pending:'排队中',parsing:'解析中',chunking:'分块中',embedding:'索引中',archived:'已归档'} as any)[s.status]??s.status}: {s.n}
            </Tag>
          ))}
        </Space>
      </Card>
    </Space>
  )
}
