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

      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title="问答总数" value={data.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="无答案率"
              value={fmtPercent(data.unansweredRate)}
              valueStyle={unansweredHigh ? { color: '#cf1322' } : undefined}
            />
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              {unansweredHigh ? '偏高,检查摄取或补充文档' : '正常'}
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="负面反馈率"
              value={fmtPercent(data.negativeRate)}
              valueStyle={data.negativeRate > 0.15 ? { color: '#cf1322' } : undefined}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="深度检索占比"
              value={fmtPercent(data.agenticRate)}
              valueStyle={agenticHigh ? { color: '#d46b08' } : undefined}
            />
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              {agenticHigh ? '超过 25%,客户端判定可能过松' : '正常'}
            </div>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="检索延迟">
        <Row gutter={16}>
          <Col span={8}><Statistic title="平均" value={data.latency.avg ?? '—'} suffix="ms" /></Col>
          <Col span={8}><Statistic title="p50" value={data.latency.p50 ?? '—'} suffix="ms" /></Col>
          <Col span={8}>
            <Statistic
              title="p95"
              value={data.latency.p95 ?? '—'}
              suffix="ms"
              valueStyle={(data.latency.p95 ?? 0) > 800 ? { color: '#cf1322' } : undefined}
            />
          </Col>
        </Row>
        <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
          p95 目标 ≤ 800ms。超标先看精排是否被跳过(服务端日志会记录降级原因)。
        </div>
      </Card>

      <Card
        size="small"
        title="知识盲区"
        extra={<span style={{ fontSize: 12, color: '#999' }}>没答上来的问题,可直接作为补充文档的清单</span>}
      >
        <Table
          rowKey="question"
          size="small"
          pagination={false}
          dataSource={data.blindSpots}
          locale={{ emptyText: '暂无' }}
          columns={[
            { title: '问题', dataIndex: 'question' },
            { title: '被问次数', dataIndex: 'n', width: 100 },
          ]}
        />
      </Card>

      <Row gutter={16}>
        <Col span={12}>
          <Card size="small" title="被标记为无用或错误的回答">
            <Table
              rowKey={(r) => `${r.question}-${r.createdAt}`}
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
                { title: '时间', dataIndex: 'createdAt', width: 140, render: fmtTime },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card
            size="small"
            title="从未被引用的文档"
            extra={<span style={{ fontSize: 12, color: '#999' }}>候选归档对象</span>}
          >
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={data.unusedDocs}
              locale={{ emptyText: '暂无' }}
              columns={[
                { title: '标题', dataIndex: 'title' },
                { title: '上传时间', dataIndex: 'createdAt', width: 140, render: fmtTime },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="文档摄取状态分布">
        <Space wrap>
          {data.docStats.map((s) => (
            <Tag key={s.status} color={s.status === 'failed' ? 'error' : s.status === 'ready' ? 'success' : 'default'}>
              {s.status}: {s.n}
            </Tag>
          ))}
        </Space>
      </Card>
    </Space>
  )
}
