import { useState } from 'react'
import {
  Input, Card, Space, Tag, Empty, Descriptions, Alert, Switch, Typography, Spin,
} from 'antd'
import * as api from '../api'
import { memoryKindLabel } from '../utils/format'

type Result = Awaited<ReturnType<typeof api.retrieve>>

/**
 * 检索自测。
 *
 * 管理员需要一个地方确认"上传的文档到底能不能被查到",而不是等员工来报障。
 * 诊断信息(两路召回数、精排耗时、是否降级)直接暴露出来 —— 排查召回问题时,
 * 知道"BM25 命中 0 条"和"精排被跳过"是完全不同的两个方向。
 */
export default function SearchTest() {
  const [result, setResult] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const [multiHop, setMultiHop] = useState(false)
  const [asked, setAsked] = useState('')

  const search = async (q: string): Promise<void> => {
    if (!q.trim()) return
    setLoading(true)
    setAsked(q)
    try {
      setResult(await api.retrieve({ query: q, limit: 8, multiHop }))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="以你自己的权限检索"
        description="结果与你的可见范围和密级一致,不代表其他员工能看到同样的内容。"
      />

      <Space>
        <Input.Search
          placeholder="输入一个员工可能会问的问题"
          style={{ width: 480 }}
          enterButton="检索"
          size="large"
          onSearch={search}
        />
        <Space>
          <Switch checked={multiHop} onChange={setMultiHop} />
          <span style={{ fontSize: 13 }}>多跳检索</span>
        </Space>
      </Space>

      {loading && <Spin />}

      {result && !loading && (
        <>
          <Card size="small" title="诊断">
            <Descriptions size="small" column={3}>
              <Descriptions.Item label="关键词召回">{result.diagnostics.bm25Hits} 条</Descriptions.Item>
              <Descriptions.Item label="语义召回">{result.diagnostics.vecHits} 条</Descriptions.Item>
              <Descriptions.Item label="融合候选">{result.diagnostics.fusedCandidates} 条</Descriptions.Item>
              <Descriptions.Item label="精排耗时">{result.diagnostics.rerankMs} ms</Descriptions.Item>
              <Descriptions.Item label="总耗时">
                <span style={{ color: result.diagnostics.totalMs > 800 ? '#cf1322' : undefined }}>
                  {result.diagnostics.totalMs} ms
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="精排">
                {result.diagnostics.rerankSkipped ? (
                  <Tag color="warning">已跳过(降级)</Tag>
                ) : (
                  <Tag color="success">正常</Tag>
                )}
              </Descriptions.Item>
            </Descriptions>
            {result.diagnostics.bm25Hits === 0 && result.diagnostics.vecHits > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                message="关键词一路没有命中"
                description="若问题里含型号、缩写等精确词却查不到,通常是中文分词或索引问题。"
              />
            )}
          </Card>

          {result.memories.length > 0 && (
            <Card size="small" title="组织记忆">
              <Space direction="vertical" style={{ width: '100%' }}>
                {result.memories.map((m) => (
                  <div key={m.id}>
                    <Tag>{memoryKindLabel(m.kind)}</Tag>
                    {m.content}
                  </div>
                ))}
              </Space>
            </Card>
          )}

          {result.chunks.length === 0 ? (
            <Empty
              description={
                <Space direction="vertical">
                  <span>没有检索到相关内容 —— 这种情况下客户端会明确回答"没找到",而不是编答案</span>
                  {result.suggestAsk?.length ? (
                    <span style={{ fontSize: 13, color: '#888' }}>
                      建议询问:{result.suggestAsk.map((p) => p.displayName).join('、')}
                    </span>
                  ) : null}
                </Space>
              }
            />
          ) : (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                「{asked}」命中 {result.chunks.length} 条材料,按相关度排序
              </Typography.Text>
              {result.chunks.map((c, i) => (
                <Card
                  key={c.chunkId}
                  size="small"
                  title={
                    <Space wrap>
                      <Tag color="blue">[{i + 1}]</Tag>
                      <span>{c.docTitle}</span>
                      {c.citation.page != null && <Tag>第 {c.citation.page} 页</Tag>}
                      {c.citation.heading && (
                        <span style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>
                          {c.citation.heading}
                        </span>
                      )}
                      {c.stale && <Tag color="warning">可能过时</Tag>}
                    </Space>
                  }
                  extra={
                    <Space size={4}>
                      <Tag color={c.scopeKind === 'org' ? 'blue' : 'geekblue'}>
                        {c.scopeKind === 'org' ? '全公司' : '团队'}
                      </Tag>
                      <span style={{ fontSize: 12, color: '#999' }}>
                        {c.score.toFixed(3)}
                      </span>
                    </Space>
                  }
                >
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{c.text}</div>
                  {c.owner && (
                    <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>
                      维护人:{c.owner.displayName}
                    </div>
                  )}
                </Card>
              ))}
            </Space>
          )}
        </>
      )}
    </Space>
  )
}
