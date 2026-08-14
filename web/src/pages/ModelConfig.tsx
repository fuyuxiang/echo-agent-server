import { useEffect, useState } from 'react'
import { Card, Form, Input, Select, Button, message, Alert, Tag, Space, InputNumber } from 'antd'
import * as api from '../api'
import type { ModelConfig as Cfg } from '../types'
import { fmtTime } from '../utils/format'

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI / 兼容接口' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'ollama', label: 'Ollama(本地)' },
  { value: 'compatible', label: '其他 OpenAI 兼容服务' },
]

export default function ModelConfig() {
  const [form] = Form.useForm()
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    const c = await api.getModelConfig()
    setCfg(c)
    form.setFieldsValue({
      chatProvider: c.chatProvider ?? 'openai',
      chatModel: c.chatModel ?? '',
      chatBaseUrl: c.chatBaseUrl ?? '',
      embedModel: c.embedModel ?? 'bge-m3',
      embedDim: c.embedDim ?? 1024,
      rerankModel: c.rerankModel ?? '',
      vlmModel: c.vlmModel ?? '',
    })
  }

  useEffect(() => { void load() }, [])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="success"
        showIcon
        message="API Key 只保存在服务端"
        description="推理请求由服务端代理转发,密钥不会下发到员工电脑。这样离职或换机时无需逐台回收,撤销一次即全局生效。"
      />

      <Alert
        type="warning"
        showIcon
        message="更换嵌入模型需要重建全部索引"
        description="不同模型的向量空间不可混用。改动 embedModel 或 embedDim 后,已有文档需逐一「重建」才能被正确检索。"
      />

      <Card
        title="模型配置"
        extra={
          cfg?.updatedAt ? (
            <span style={{ fontSize: 12, color: '#999' }}>更新于 {fmtTime(cfg.updatedAt)}</span>
          ) : null
        }
      >
        <Form
          form={form}
          layout="vertical"
          style={{ maxWidth: 560 }}
          onFinish={async (v) => {
            setBusy(true)
            try {
              await api.putModelConfig(v)
              message.success('已保存')
              await load()
              // 保存成功后清空 Key 输入框,避免它留在 DOM 里。
              form.setFieldValue('chatKey', undefined)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Form.Item name="chatProvider" label="对话模型服务商" rules={[{ required: true }]}>
            <Select options={PROVIDERS} />
          </Form.Item>
          <Form.Item name="chatModel" label="对话模型" rules={[{ required: true }]}>
            <Input placeholder="如 gpt-4o / claude-sonnet-4" />
          </Form.Item>
          <Form.Item name="chatBaseUrl" label="接口地址" extra="使用官方接口可留空">
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item
            name="chatKey"
            label={
              <Space>
                API Key
                {cfg?.hasCredential && <Tag color="success">已配置</Tag>}
              </Space>
            }
            extra={cfg?.hasCredential ? '留空则保留现有密钥,填写则覆盖' : '首次配置必填'}
          >
            <Input.Password placeholder={cfg?.hasCredential ? '不修改则留空' : 'sk-...'} autoComplete="off" />
          </Form.Item>

          <Form.Item name="embedModel" label="嵌入模型" rules={[{ required: true }]}>
            <Input placeholder="bge-m3" />
          </Form.Item>
          <Form.Item
            name="embedDim"
            label="向量维度"
            rules={[{ required: true }]}
            extra="须与嵌入模型实际输出一致,否则检索结果会错乱"
          >
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="rerankModel"
            label="精排模型"
            extra="交叉编码器。它是准确率从「能用」到「可信」的分界,建议配置"
          >
            <Input placeholder="bge-reranker-v2-m3" />
          </Form.Item>
          <Form.Item name="vlmModel" label="图像理解模型" extra="用于给图片、图表生成文字描述">
            <Input placeholder="可选" />
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={busy}>保存</Button>
        </Form>
      </Card>
    </Space>
  )
}
