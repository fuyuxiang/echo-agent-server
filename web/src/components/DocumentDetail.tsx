import SecurityChecks from '../pages/SecurityChecks';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Form, Input, Modal, Select, Space, Spin, Table, Tabs, Tag, Upload, message } from 'antd';
import * as api from '../api';
import * as ops from '../api/operations';
import client from '../api/client';
import type { DocumentItem } from '../types';
import { fmtTime } from '../utils/format';
const status = (v: string) => ({ pending: '排队中', parsing: '解析中', chunking: '分块中', embedding: '索引中', ready: '可检索', failed: '失败', archived: '已归档' } as any)[v] ?? v;
export default function DocumentDetail({ doc, onClose, onChanged, onPreview }: {
    doc: DocumentItem | null;
    onClose: () => void;
    onChanged: () => void;
    onPreview: (doc: DocumentItem) => void;
}) {
    const [data, setData] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saving, setSaving] = useState(false), [form] = Form.useForm(), seq = useRef(0);
    const [scopes,setScopes]=useState<any[]>([]),[maintainers,setMaintainers]=useState<any[]>([]);
    const scopeId=Form.useWatch('scopeId',form),sensitivity=Form.useWatch('sensitivity',form);
    useEffect(()=>{if(doc)void api.listScopes().then(rows=>setScopes(rows.filter(x=>x.kind!=='personal'))).catch(()=>{})},[doc?.id]);
    useEffect(()=>{if(scopeId)void client.get('/api/v1/admin/asset-maintainers',{params:{scopeId,sensitivity:sensitivity??0}}).then((rows:any)=>setMaintainers(rows)).catch(()=>setMaintainers([]))},[scopeId,sensitivity]);
    const load = async () => { if (!doc)
        return; const n = ++seq.current; setBusy(true); setError(''); try {
        const x = await ops.getDocVersions(doc.id);
        if (n === seq.current)
            setData(x);
    }
    catch {
        if (n === seq.current)
            setError('版本信息加载失败，请重试');
    }
    finally {
        if (n === seq.current)
            setBusy(false);
    } };
    useEffect(() => { setData(null); form.resetFields(); if (doc) {
        form.setFieldsValue({ ...doc });
        void load();
    } return () => { seq.current++; }; }, [doc?.id]);
    return <Drawer open={!!doc} title={doc?.title} onClose={onClose} width={700} destroyOnClose>{doc && <Space direction="vertical" size={16} style={{ width: '100%' }}><div className="echo-detail-summary"><Tag>{doc.scopeKind === 'personal' ? '我的空间' : doc.scopeName}</Tag><Tag color={doc.status === 'ready' ? 'success' : doc.status === 'failed' ? 'error' : 'processing'}>{status(doc.status)}</Tag><Tag>v{doc.version}</Tag><Tag>{['组织内公开', '内部', '机密'][doc.sensitivity]}</Tag></div>{doc.failReason && <Alert type="error" message={doc.failReason} showIcon/>}<Space wrap>{doc.status === 'ready' && <><Button type="primary" onClick={() => onPreview(doc)}>阅读内容</Button><Button onClick={() => void api.downloadDocRaw(doc.id).then(b => ops.downloadBlob(b, doc.title)).catch(() => { })}>下载原件</Button><Upload showUploadList={false} accept={`.${doc.sourceType}`} beforeUpload={file => { setSaving(true); void ops.uploadVersion(doc.id, file).then(() => { message.success('新版本已入队，完成前继续使用当前版本'); void load(); onChanged(); }).catch(() => { }).finally(() => setSaving(false)); return false; }}><Button loading={saving}>上传新版本</Button></Upload></>}<Button onClick={() => void load()}>刷新状态</Button></Space>{error && <Alert type="error" message={error} action={<Button onClick={() => void load()}>重试</Button>}/>}<Tabs items={[{ key: 'info', label: '基本信息', children: <><Descriptions size="small" column={2} items={[{ key: 'owner', label: '维护人', children: doc.ownerName ?? '未指定' }, { key: 'indexed', label: '索引时间', children: fmtTime(doc.indexedAt) }, { key: 'created', label: '创建时间', children: fmtTime(doc.createdAt) }, { key: 'chunks', label: '知识片段', children: doc.chunkCount }]}/><Form form={form} layout="vertical" onFinish={async (v) => { setSaving(true); try {
                await api.patchDoc(doc.id, { ...v, ifUnmodifiedSince: doc.updatedAt });
                message.success('元数据已保存');
                onChanged();
                onClose();
            }
            catch { }
            finally {
                setSaving(false);
            } }}><Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="ownerId" label="维护人" extra="仅可选择有权访问此文档的启用成员；交接会更新该文档的各版本维护归属。"><Select allowClear showSearch optionFilterProp="label" options={maintainers.map(x=>({value:x.id,label:`${x.displayName} (${x.username})`}))}/></Form.Item><Form.Item name="scopeId" label="可见范围"><Select options={scopes.map(x=>({value:x.id,label:x.name}))}/></Form.Item><Form.Item name="sensitivity" label="密级"><Select options={[{value:0,label:'组织内公开'},{value:1,label:'内部'},{value:2,label:'机密'}]}/></Form.Item><Form.Item name="tags" label="标签"><Select mode="tags" tokenSeparators={[',', '，']}/></Form.Item><Form.Item name="volatility" label="时效性"><Select options={[{ value: 'stable', label: '稳定知识' }, { value: 'volatile', label: '易变知识' }]}/></Form.Item><Button type="primary" htmlType="submit" loading={saving}>保存信息</Button></Form></> }, { key: 'versions', label: '版本历史', children: <Spin spinning={busy}><Table rowKey="id" dataSource={data?.versions ?? []} pagination={false} columns={[{ title: '版本', render: (_: unknown, v: any) => <Space>v{v.version}{data?.family?.currentDocumentId === v.id && <Tag color="green">当前</Tag>}</Space> }, { title: '状态', dataIndex: 'status', render: status }, { title: '索引', render: (_: unknown, v: any) => <Space direction="vertical" size={0}><small>全文：{({ready:'就绪',pending:'待处理',failed:'失败'} as any)[v.ftsStatus]??v.ftsStatus}</small><small>向量：{({ready:'就绪',pending:'待处理',failed:'失败',degraded:'降级'} as any)[v.vectorStatus]??v.vectorStatus}</small></Space> }, { title: '创建时间', dataIndex: 'createdAt', render: fmtTime }, { title: '', render: (_: unknown, v: any) => v.status === 'ready' && data?.family?.currentDocumentId !== v.id && <Button type="link" onClick={() => Modal.confirm({ title: `启用 v${v.version}？`, content: '会将该版本设为当前检索版本，保留其他版本与历史引用。', onOk: async () => { await client.post(`/api/v1/docs/${v.id}/activate`, { currentDocumentId: data.family.currentDocumentId, note: '管理端手动切换版本' }); message.success('已切换'); void load(); onChanged(); } })}>启用</Button> }]} expandable={{ expandedRowRender: (v: any) => <span>{v.failReason ?? `索引模型：${v.indexModelVersion ?? '尚无'}`}</span> }}/></Spin> }, {key:'security',label:'安全记录',children:<SecurityChecks defaultKind="document" assetId={doc.id}/>}, { key: 'jobs', label: '处理记录', children: <Table rowKey="id" dataSource={data?.jobs ?? []} pagination={{ pageSize: 10 }} columns={[{ title: '阶段', dataIndex: 'stage',render:(s:string)=>({parse:'解析',chunk:'分块',embed:'嵌入',finalize:'完成校验'} as any)[s]??s }, { title: '状态', dataIndex: 'state',render:(s:string)=>({queued:'排队中',running:'处理中',done:'完成',failed:'失败'} as any)[s]??s }, { title: '尝试次数', dataIndex: 'attempts' }, { title: '最近错误', dataIndex: 'lastError', render: (s: string) => s ?? '—' }]}/> }]}/></Space>}</Drawer>;
}
