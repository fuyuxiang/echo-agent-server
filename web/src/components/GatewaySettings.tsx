import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table, message } from 'antd';
import * as ops from '../api/operations';
import { fmtTime } from '../utils/format';
export default function GatewaySettings() {
    const [form] = Form.useForm(), [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false), [testing, setTesting] = useState(false), [result, setResult] = useState<any>(null), [history, setHistory] = useState<any[]>([]), [open, setOpen] = useState(false);
    const load = async () => { try {
        form.setFieldsValue(await ops.getGatewaySettings());
        setLoaded(true);
    }
    catch { } };
    useEffect(() => { void load(); }, []);
    return <Space direction="vertical" style={{ width: '100%' }} size={16}><Card title="网关与计价" extra={<Button loading={testing} onClick={async () => { setTesting(true); try {
        setResult(await ops.testModel());
    }
    catch { }
    finally {
        setTesting(false);
    } }}>测试已保存的上游连接</Button>}>
 {result && <Alert showIcon closable type={result.success ? 'success' : 'error'} message={result.message} description={`耗时 ${result.latencyMs} ms${result.httpStatus ? ` · HTTP ${result.httpStatus}` : ''}；测试调用会记录实际用量。`} style={{ marginBottom: 16 }}/>}
 <Form form={form} layout="vertical" onFinish={async (v) => { setSaving(true); try {
        await ops.putGatewaySettings({ ...v, publicBaseUrl: v.publicBaseUrl ?? '', inputPrice: v.inputPrice ?? null, cachedPrice: v.cachedPrice ?? null, outputPrice: v.outputPrice ?? null });
        message.success('网关配置已保存');
        await load();
    }
    catch { }
    finally {
        setSaving(false);
    } }}>
 <Form.Item name="publicBaseUrl" label="下发给客户端的 Base URL" extra="留空则使用访问服务器的地址，例如 https://服务器IP:8787/api/v1/llm/v1；反向代理部署时请显式填写对外地址。"><Input placeholder={`${location.origin}/api/v1/llm/v1`}/></Form.Item>
 <Row gutter={16}><Col xs={24} sm={12}><Form.Item name="maxOutputTokens" label="单次最大输出 Token" rules={[{ required: true }]}><InputNumber min={1} max={262144} style={{ width: '100%' }}/></Form.Item></Col><Col xs={24} sm={12}><Form.Item name="protocols" label="允许的兼容协议" extra="只启用上游实际支持的协议" rules={[{ required: true }]}><Select mode="multiple" options={[{ value: 'chat', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }, { value: 'anthropic', label: 'Anthropic Messages' }, { value: 'images', label: '图像生成' }, { value: 'speech', label: '语音合成' }, { value: 'transcription', label: '音频转写' }]}/></Form.Item></Col></Row>
 <Row gutter={16}><Col xs={24} md={8}><Form.Item name={['models', 'images']} label="图像生成模型"><Input placeholder="启用该能力时填写"/></Form.Item></Col><Col xs={24} md={8}><Form.Item name={['models', 'speech']} label="语音合成模型"><Input placeholder="启用该能力时填写"/></Form.Item></Col><Col xs={24} md={8}><Form.Item name={['models', 'transcription']} label="音频转写模型"><Input placeholder="启用该能力时填写"/></Form.Item></Col></Row>
 <Alert type="info" message="单价单位：每百万 Token。留空表示未知价格；输入单价用于非缓存输入，缓存和输出分别计价。变更只影响之后的调用。" style={{ marginBottom: 16 }}/>
 <Row gutter={16}><Col xs={12} md={6}><Form.Item name="inputPrice" label="输入单价"><InputNumber min={0} style={{ width: '100%' }}/></Form.Item></Col><Col xs={12} md={6}><Form.Item name="cachedPrice" label="缓存输入单价"><InputNumber min={0} style={{ width: '100%' }}/></Form.Item></Col><Col xs={12} md={6}><Form.Item name="outputPrice" label="输出单价"><InputNumber min={0} style={{ width: '100%' }}/></Form.Item></Col><Col xs={12} md={6}><Form.Item name="currency" label="币种"><Select options={[{ value: 'CNY', label: '人民币' }, { value: 'USD', label: '美元' }]}/></Form.Item></Col></Row>
 <Button type="primary" htmlType="submit" disabled={!loaded} loading={saving}>保存网关配置</Button>
 </Form></Card><Card title="配置历史" extra={<Button onClick={async () => { try {
        setHistory(await ops.getConfigHistory());
        setOpen(true);
    }
    catch { } }}>查看与恢复</Button>}>历史版本保留加密凭证，恢复后生成更高的配置版本，已有调用继续使用原计价快照。</Card>
 <Modal open={open} onCancel={() => setOpen(false)} title="模型配置历史" width={800} footer={null}><Table rowKey="id" dataSource={history} columns={[{ title: '时间', dataIndex: 'createdAt', render: fmtTime }, { title: '模型', render: (_: unknown, h: any) => h.config?.chat_model ?? '初始环境配置' }, { title: '上游地址', render: (_: unknown, h: any) => h.config?.chat_base_url ?? '—' }, { title: '', render: (_: unknown, h: any) => h.config && <Button onClick={() => Modal.confirm({ title: '恢复此配置？', content: '当前配置会先保存为历史记录。客户端下次同步时获取新配置。', onOk: async () => { await ops.rollbackConfig(h.id); message.success('已恢复'); setOpen(false); window.location.reload(); } })}>恢复</Button> }]} pagination={{ pageSize: 8 }}/></Modal>
 </Space>;
}
