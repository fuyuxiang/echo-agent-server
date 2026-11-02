import ScanReport from '../components/ScanReport';
import DeviceTable from '../components/DeviceTable';
import MaintenanceList from '../components/MaintenanceList';
import UsageTrend from '../components/UsageTrend';
import { Link, useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Collapse, Descriptions, Drawer, Form, Input, InputNumber, List, Modal, Popconfirm, Progress, Row, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Typography, message } from 'antd';
import { ArrowRightOutlined, DownloadOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import * as ops from '../api/operations';
import * as api from '../api';
import client from '../api/client';
import { fmtTime } from '../utils/format';
function useRemote<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
    const [data, setData] = useState<T | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
    const seq = useRef(0);
    const reload = useCallback(async () => { const n = ++seq.current; setLoading(true); setError(''); try {
        const value = await fetcher();
        if (n === seq.current)
            setData(value);
    }
    catch (e) {
        if (n === seq.current)
            setError(e instanceof Error ? e.message : '加载失败');
    }
    finally {
        if (n === seq.current)
            setLoading(false);
    } }, deps);
    useEffect(() => { void reload(); return () => { seq.current++; }; }, [reload]);
    return { data, loading, error, reload };
}
function RemoteError({ error, reload }: {
    error: string;
    reload: () => Promise<void>;
}) { return error ? <Alert type="error" showIcon message="暂时无法加载" description={error} action={<Button onClick={() => void reload()}>重试</Button>}/> : null; }
function Refresh({ reload, loading }: {
    reload: () => Promise<void>;
    loading: boolean;
}) { return <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>刷新</Button>; }
const parseJson=(value:string|null|undefined)=>{try{return JSON.parse(value??'{}')}catch{return {}}};
const number = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('zh-CN');
const sourceName: Record<string, string> = { desktop_chat: '客户端对话', knowledge_reasoning: '知识问答', embedding: '嵌入', rerank: '精排', document_ingest: '文档处理', vision: '图像理解', ocr: '文字识别', transcription: '音频转写', connection_test: '连接测试',images:'图像生成',speech:'语音合成' };
const stateTag = (s: string) => <Tag color={s === 'complete' ? 'success' : s === 'pending' ? 'processing' : 'warning'}>{({ complete: '已结算', pending: '执行中', partial: '部分用量', unknown: '待核对' } as Record<string, string>)[s] ?? s}</Tag>;
export function Workspace() {
 const r=useRemote(ops.getWorkspace),nav=useNavigate(),d=r.data;
 const tasks=d?[
  ['安全检查需恢复',d.operations.safetyFailed,'检查服务故障或需跟进异常','/security?view=attention'],
  ['文档处理失败',d.operations.failedJobs,'查看失败阶段并重试','/jobs?state=failed'],
  ['经验到期待复核',d.memories.expired??0,'核对适用范围与时效','/memories?expired=true'],
  ['模型用量待核对',d.operations.unsettledCalls,'核对上游记录并释放预留','/usage?state=unsettled&tab=calls'],
  ['知识维护事项',d.operations.openMaintenance,'补充知识并记录复测结果','/quality?tab=maintenance'],
 ].filter(x=>Number(x[1])>0):[];
 return <Space direction="vertical" size={20} style={{width:'100%'}}>
  <RemoteError {...r}/><div className="echo-section-top"><span className="echo-help">关注知识复用、需要行动的异常与模型运行情况</span><Refresh {...r}/></div>
  {r.loading&&!d?<Spin/>:d&&<>
   <Row className="echo-metrics" gutter={[16,16]}>{[['可检索文档',d.documents.ready??0,'/documents'],['在库经验',d.memories.total??0,'/memories'],['自动检查中',d.operations.safetyPending,'/security?view=all'],['启用成员',d.operations.activeUsers,'/users']].map(([label,value,path])=><Col xs={12} xl={6} key={String(label)}><Card hoverable role="link" tabIndex={0} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();nav(String(path))}}} onClick={()=>nav(String(path))}><Statistic title={label} value={Number(value)}/><span className="echo-muted">查看详情 <ArrowRightOutlined/></span></Card></Col>)}</Row>
   <Row gutter={[20,20]}><Col xs={24} xl={14}><Card title="近 30 天知识复用" extra={<Button type="link" onClick={()=>nav('/quality')}>质量改进</Button>}><Row gutter={[16,16]}><Col span={8}><Statistic title="组织问答" value={d.quality?.total??0}/></Col><Col span={8}><Statistic title="引用知识的回答" value={d.quality?.cited?.answers??0}/></Col><Col span={8}><Statistic title="收到反馈" value={d.quality?.feedback??0}/></Col></Row><p className="echo-help">{(d.quality?.total??0)<20?'问答样本较少，仅作观察；暂无反馈不代表答案满意。':'结合实际引用与成员反馈定位需要改进的知识。'}</p></Card></Col>
   <Col xs={24} xl={10}><Card title="模型服务"><Space direction="vertical" style={{width:'100%'}}><div>上游连接：<Tag color={d.model?.connection?.success?'success':d.model?.connection?'error':'default'}>{d.model?.connection?.success?'最近实际验证成功':d.model?.connection?'最近验证未通过':'当前配置尚未验证'}</Tag></div><span className="echo-muted">{d.model?.connection?fmtTime(d.model.connection.checkedAt):'可在模型连接页执行实际验证'}</span><div>近 24 小时调用：{d.model?.successful??0} 次成功 / {d.model?.calls??0} 次</div><div>客户端上报：{d.coverage?.reported??0} / {d.coverage?.total??0} 台</div></Space></Card></Col></Row>
   <Row gutter={[20,20]}><Col xs={24} xl={14}><Card title="需要关注" extra={<Tag>{tasks.length} 类事项</Tag>}>
    {tasks.length?<List dataSource={tasks} renderItem={([title,count,description,path])=><List.Item extra={<Button type="link" onClick={()=>nav(String(path))}>处理 <ArrowRightOutlined/></Button>}><List.Item.Meta title={<Space>{title}<Tag color="warning">{number(Number(count))}</Tag></Space>} description={description}/></List.Item>}/>:<div className="echo-empty-healthy">当前没有需要人工处理的异常，内容会自动检查与发布。</div>}
    <Button type="link" onClick={()=>nav('/security?view=isolated')}>查看历史隔离记录（{d.operations.isolated??0}）</Button>
   </Card></Col><Col xs={24} xl={10}><Card title="管理快捷入口"><Row gutter={[12,12]}>{[['成员与接入','管理成员权限，查看设备和模型应用情况','/users'],['模型连接','配置并验证真实上游连接','/model-config'],['用量与排名','了解消耗、趋势及待核对记录','/usage'],['运行与备份','查看服务能力与知识资产备份','/system']].map(([title,description,path])=><Col xs={24} sm={12} key={path}><Button className="echo-entry" block onClick={()=>nav(path)}><span><strong>{title}</strong><small>{description}</small></span><ArrowRightOutlined/></Button></Col>)}</Row></Card></Col></Row>
   <Card title="最近更新的共享文档" extra={<Button type="link" onClick={()=>nav('/documents')}>全部文档</Button>}><List dataSource={d.recent} locale={{emptyText:'暂无共享文档'}} renderItem={(item:any)=><List.Item extra={<Tag color={item.status==='ready'?'success':item.status==='failed'?'error':'processing'}>{({ready:'可检索',failed:'处理失败',pending:'排队中',parsing:'解析中',embedding:'索引中',archived:'已归档'} as any)[item.status]??item.status}</Tag>}><List.Item.Meta title={<Button type="link" style={{padding:0}} onClick={()=>nav(`/documents?docId=${item.id}`)}>{item.title}</Button>} description={fmtTime(item.updatedAt)}/></List.Item>}/></Card>
  </>}
 </Space>;
}
export function Usage({fixedUser}:{fixedUser?:string}={}) {
    const [search]=useSearchParams();
    const [activeTab,setActiveTab]=useState(fixedUser?'calls':search.get('tab')??'ranking');
    const initialState=search.get('state')??undefined;
    const [days, setDays] = useState(30), [userId, setUser] = useState<string|undefined>(fixedUser??search.get('userId')??undefined), [departmentId, setDepartment] = useState<string>(), [state, setState] = useState<string|undefined>(initialState), [source, setSource] = useState<string>(), [page, setPage] = useState(1);
    const [users, setUsers] = useState<any[]>([]), [groups, setGroups] = useState<any[]>([]), [detail, setDetail] = useState<any>(null), [settling, setSettling] = useState(false);
    const [form] = Form.useForm();
    const params = { from: Date.now() - days * 86400000, userId:fixedUser??userId, departmentId, state, source, page, size: 25 };
    const r = useRemote(() => ops.getUsage(params), [days, userId, fixedUser, departmentId, state, source, page]);
    const d = r.data;
    useEffect(()=>{if(!fixedUser){setUser(search.get('userId')??undefined);setState(search.get('state')??undefined);setActiveTab(search.get('tab')??'ranking');setPage(1)}},[search.get('userId'),search.get('state'),search.get('tab'),fixedUser]);
    useEffect(() => { {
        void api.listUsers().then(setUsers).catch(() => { });
        void api.listGroups().then(setGroups).catch(() => { });
    } }, []);
    const reset = (fn: () => void) => { fn(); setPage(1); };
    return <Space direction="vertical" size={16} style={{ width: '100%' }}>
  <RemoteError {...r}/><div className="echo-section-top"><Space wrap><Select aria-label="统计周期" value={days} onChange={v => reset(() => setDays(v))} options={[{ value: 7, label: '近 7 天' }, { value: 30, label: '近 30 天' }, { value: 90, label: '近 90 天' }, { value: 365, label: '近一年' }]}/>{<><Select allowClear showSearch optionFilterProp="label" placeholder="全部用户" style={{ width: 160 }} value={fixedUser??userId} onChange={v => reset(() => setUser(v))} options={users.map(u => ({ value: u.id, label: `${u.displayName} (${u.username})` }))} disabled={!!fixedUser}/><Select allowClear placeholder="历史归属部门" style={{ width: 160 }} value={departmentId} onChange={v => reset(() => setDepartment(v))} options={groups.map(g => ({ value: g.id, label: g.name }))}/></>}<Select allowClear placeholder="全部结算状态" style={{ width: 150 }} value={state} onChange={v => reset(() => setState(v))} options={['complete', 'unsettled', 'partial', 'unknown', 'pending'].map(v => ({ value: v, label: ({ complete: '已结算', unsettled:'待核对（全部）', partial: '部分用量', unknown: '待核对', pending: '执行中' } as any)[v] }))}/><Select allowClear placeholder="全部调用场景" style={{ width: 150 }} value={source} onChange={v => reset(() => setSource(v))} options={Object.entries(sourceName).map(([value, label]) => ({ value, label }))}/></Space><Space><Refresh {...r}/><Button icon={<DownloadOutlined />} onClick={() => void ops.exportUsage(params).then(b => ops.downloadBlob(b, 'Echo-模型用量.csv')).catch(() => { })}>导出</Button></Space></div>
  <Alert showIcon type="info" message="按上游实际返回的 Token 统计，缓存 Token 已包含在输入中。待核对记录不会显示为零；费用来自调用时价格估算或管理员核对值。"/>
  {d && <><Row className="echo-metrics" gutter={[16, 16]}>{[['实际 Token', d.coverage?.known===0&&d.summary.calls?'—':d.summary.totalTokens], ['输入 / 输出', d.coverage?.known===0&&d.summary.calls?'— / —':`${number(d.summary.inputTokens)} / ${number(d.summary.outputTokens)}`], ['调用次数', d.summary.calls], ['未完整结算', d.summary.unsettled ?? 0]].map(([label, value]) => <Col key={label} xs={12} xl={6}><Card><Statistic title={label} value={value}/></Card></Col>)}</Row>
  <div className="echo-muted">更新于 {fmtTime(d.updatedAt)} · 按调用开始时间归属（北京时间） · {d.costs.length ? d.costs.map((c: any) => `${c.currency} ${c.estimatedCost.toFixed(4)}（${c.pricedCalls} 次已定价调用）`).join('；') : '尚无可估算费用'}</div>
  <div className="echo-help">本账本自 {fmtTime(d.collectionStartedAt)} 起记录；当前筛选 {d.coverage?.total??d.summary.calls} 次调用，完整结算 {d.coverage?.complete??0} 次。Token 排名表示消耗量，知识贡献请查看质量改进。</div>
  <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
                { key: 'ranking', label: '用户排名', children: <Table scroll={{ x: 650 }} rowKey="userId" dataSource={d.rankings.map((x:any,i:number)=>({...x,rank:i+1}))} locale={{emptyText:'暂无可排名的已知 Token 用量'}} loading={r.loading} pagination={{ pageSize: 20 }} columns={[{ title: '排名', dataIndex:'rank', width: 70 }, { title: '用户', render: (_: unknown, u: any) => u.userId?<Link to={`/users/${u.userId}`}>{u.displayName??u.username}</Link>:'系统任务' }, { title: '实际 Token', dataIndex: 'totalTokens', render: number, defaultSortOrder: 'descend', sorter: (a: any, b: any) => a.totalTokens - b.totalTokens }, { title: '输入', dataIndex: 'inputTokens', render: number }, { title: '输出', dataIndex: 'outputTokens', render: number }, { title: '调用', dataIndex: 'calls', render: number }, { title: '未结算', dataIndex: 'unsettled', render: (v: number) => v ? <Tag color="warning">{v}</Tag> : '—' }]}/> },
                { key: 'trend', label: '用量趋势', children: <UsageTrend items={d.trend}/> },
                { key: 'departments', label: '部门与场景', children: <Row gutter={[16, 16]}><Col xs={24} xl={12}><Table rowKey="name" dataSource={d.departments} pagination={{ pageSize: 10 }} columns={[{ title: '历史归属部门', dataIndex: 'name' }, { title: '调用', dataIndex: 'calls' }, { title: '实际 Token', dataIndex: 'totalTokens', render: number }]}/></Col><Col xs={24} xl={12}><Table rowKey={(x: any) => `${x.source}-${x.model}`} dataSource={d.sources} pagination={{ pageSize: 10 }} columns={[{ title: '场景', dataIndex: 'source', render: (s: string) => sourceName[s] ?? s }, { title: '模型', dataIndex: 'model' }, { title: '实际 Token', dataIndex: 'totalTokens', render: number }]}/></Col></Row> },
                { key: 'calls', label: '调用明细', children: <Table scroll={{ x: 1000 }} rowKey="id" dataSource={d.items} loading={r.loading} pagination={{ current: page, pageSize: 25, total: d.summary.calls, onChange: setPage, showSizeChanger: false }} columns={[{ title: '时间', dataIndex: 'startedAt', render: fmtTime, width: 170 }, { title: '用户', dataIndex: 'displayName' }, { title: '场景', dataIndex: 'source', render: (s: string) => sourceName[s] ?? s }, { title: '模型', dataIndex: 'model' }, { title: '结算状态', dataIndex: 'accountingState', render: stateTag }, { title: '实际 Token', dataIndex: 'totalTokens', render: number }, { title: '结果', dataIndex: 'outcome', render: (v: string) => ({ succeeded: '成功', failed: '失败', interrupted: '中断', running: '执行中' } as any)[v] ?? v }, { title: '', fixed: 'right', width: 80, render: (_: unknown, x: any) => <Button type="link" onClick={() => { setDetail(x); form.resetFields();form.setFieldsValue({inputTokens:x.inputTokens??undefined,outputTokens:x.outputTokens??undefined,cachedTokens:x.cachedTokens??0,currency:x.currency??'CNY'}); }}>详情</Button> }]}/> }
            ]}/></>}
  <Drawer open={!!detail} onClose={() => setDetail(null)} title="调用详情" width={560}>{detail && <Space direction="vertical" style={{ width: '100%' }}><Descriptions column={1} bordered size="small" items={Object.entries({ 调用ID: detail.id, 用户: detail.displayName ?? detail.username, 历史部门: detail.departmentName ?? '未分配', 模型: detail.model, 场景: sourceName[detail.source] ?? detail.source, 开始时间: fmtTime(detail.startedAt), HTTP状态: detail.httpStatus ?? '未返回', 输入Token: number(detail.inputTokens), 输出Token: number(detail.outputTokens), 缓存Token: number(detail.cachedTokens), 缓存写入Token: number(detail.cacheWriteTokens), 推理Token: number(detail.reasoningTokens), 实际总量: number(detail.totalTokens), 待核对预留: number(detail.reservedTokens), 上游请求ID: detail.upstreamRequestId ?? '—', 任务ID: detail.taskId ?? '—', 密钥ID: detail.keyId ?? '—', 费用来源:detail.costSource==='reconciled'?'管理员核对':'价格估算', 价格版本: detail.priceRevision ?? '—',其他计量单位:detail.unitsJson??'—' }).map(([label, children]) => ({ key: label, label, children }))}/>{(detail.accountingState !== 'complete'||detail.estimatedCost===null) && <Card title="核对用量与费用"><Alert type="warning" message="仅根据上游账单或请求记录填写，核对后释放预留额度。"/><Form form={form} layout="vertical" onFinish={async (v) => { setSettling(true); try {
        await ops.reconcile(detail.id, v);
        message.success('已核对');
        setDetail(null);
        void r.reload();
    }
    catch { }
    finally {
        setSettling(false);
    } }}><Form.Item name="inputTokens" label="实际输入 Token" rules={[{ required: true }]}><InputNumber disabled={detail.accountingState==='complete'} min={0} precision={0}/></Form.Item><Form.Item name="outputTokens" label="实际输出 Token" rules={[{ required: true }]}><InputNumber disabled={detail.accountingState==='complete'} min={0} precision={0}/></Form.Item><Form.Item name="cachedTokens" label="其中缓存 Token" initialValue={0}><InputNumber disabled={detail.accountingState==='complete'} min={0} precision={0}/></Form.Item><Form.Item name="actualCost" label="核对费用" extra="可根据上游账单填写；留空按调用时价格估算。"><InputNumber min={0} precision={6}/></Form.Item><Form.Item name="currency" label="费用币种"><Select options={[{value:'CNY',label:'人民币'},{value:'USD',label:'美元'}]}/></Form.Item><Form.Item name="note" label="核对依据" rules={[{ required: true, min: 3 }]}><Input.TextArea /></Form.Item><Button type="primary" htmlType="submit" loading={settling}>确认核对</Button></Form></Card>}</Space>}</Drawer>
 </Space>;
}
export function Credentials({fixedUser}:{fixedUser?:string}={}) {
    const r = useRemote(()=>ops.getKeys(fixedUser),[fixedUser]), [users, setUsers] = useState<any[]>([]), [open, setOpen] = useState(false), [secret, setSecret] = useState<any>(null), [saving, setSaving] = useState(false), [form] = Form.useForm();
    useEffect(() => {
        void api.listUsers().then(setUsers).catch(() => { }); }, []);
    return <Space direction="vertical" size={16} style={{ width: '100%' }}><RemoteError {...r}/><p className="echo-help">桌面端登录后自动获取个人密钥；手工密钥用于其他兼容工具。多个设备的消耗按成员汇总，撤销后停止新调用。</p>
  <Card title="客户端连接地址"><Typography.Paragraph copyable style={{ margin: 0 }}>{r.data?.baseUrl ?? '加载中…'}</Typography.Paragraph><span className="echo-muted">兼容 OpenAI SDK，模型由服务器统一指定。桌面端组织登录后会自动同步。</span></Card>
  <div className="echo-section-top"><Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); form.setFieldsValue({userId:fixedUser});setOpen(true); }}>创建密钥</Button><Refresh {...r}/></div>
  <Table scroll={{ x: 850 }} rowKey="id" loading={r.loading} dataSource={r.data?.items ?? []} columns={[{ title: '名称 / 设备', render: (_: unknown, k: any) => <Space direction="vertical" size={0}><strong>{k.name}</strong><span className="echo-muted">{k.deviceId ?? '手动创建'}</span></Space> }, { title: '用户', render: (_: unknown, k: any) => `${k.displayName} (${k.username})` }, { title: '密钥', dataIndex: 'prefix', render: (p: string) => <code>{p}••••••••••••</code> }, { title: '状态', dataIndex: 'status', render: (s: string) => <Tag color={s === 'active' ? 'success' : 'default'}>{({ active: '有效', revoked: '已撤销', expired: '已过期' } as any)[s]}</Tag> }, { title: '最近使用', dataIndex: 'lastUsedAt', render: fmtTime }, { title: '创建时间', dataIndex: 'createdAt', render: fmtTime }, { title: '', fixed: 'right', width: 90, render: (_: unknown, k: any) => k.status === 'active' && <Popconfirm title="撤销此密钥？" description="对应客户端需要重新同步或配置新密钥。历史用量会保留。" onConfirm={async () => { try {
                await ops.revokeKey(k.id);
                message.success('已撤销');
                void r.reload();
            }
            catch { } }}><Button danger type="link">撤销</Button></Popconfirm> }]}/>
  <Modal title="创建访问密钥" open={open} confirmLoading={saving} onCancel={() => setOpen(false)} onOk={() => form.submit()}><Form form={form} layout="vertical" onFinish={async (v) => { setSaving(true); try {
        const x = await ops.createKey({ ...v, expiresAt: v.days ? Date.now() + v.days * 86400000 : undefined });
        setOpen(false);
        setSecret(x);
        void r.reload();
    }
    catch { }
    finally {
        setSaving(false);
    } }}>{<Form.Item name="userId" label="分配给用户" rules={[{ required: true, message: '请选择密钥所属用户' }]} extra="选择实际使用此密钥的成员，调用将计入该用户的用量"><Select disabled={!!fixedUser} allowClear showSearch optionFilterProp="label" options={users.filter(u => u.status === 'active').map(u => ({ value: u.id, label: `${u.displayName} (${u.username})` }))}/></Form.Item>}<Form.Item name="name" label="用途名称" rules={[{ required: true }]}><Input placeholder="例如：研发笔记本" maxLength={80}/></Form.Item><Form.Item name="days" label="有效期" initialValue={90}><Select options={[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }, { value: 365, label: '一年' }, { value: 0, label: '长期有效' }]}/></Form.Item></Form></Modal>
  <Modal title="密钥已创建" open={!!secret} onCancel={() => setSecret(null)} footer={<Button type="primary" onClick={() => setSecret(null)}>已安全保存</Button>}><Alert type="warning" showIcon message="此密钥仅在创建时展示，请立即复制并妥善保存。"/><p>Base URL</p><Typography.Paragraph copyable>{secret?.baseUrl}</Typography.Paragraph><p>API Key</p><Typography.Paragraph copyable>{secret?.key}</Typography.Paragraph></Modal>
 </Space>;
}
export function Quotas({fixedUser}:{fixedUser?:string}={}) {
    const r = useRemote(ops.getQuotas), [editing, setEditing] = useState<any>(null), [users, setUsers] = useState<any[]>([]), [groups, setGroups] = useState<any[]>([]), [keys, setKeys] = useState<any[]>([]), [form] = Form.useForm(), [saving, setSaving] = useState(false);
    const type = Form.useWatch('targetType', form);
    useEffect(() => { {
        void api.listUsers().then(setUsers).catch(() => { });
        void api.listGroups().then(setGroups).catch(() => { });
        void ops.getKeys().then(x => setKeys(x.items)).catch(() => { });
    } }, []);
    const edit = (r: any) => { setEditing(r); form.setFieldsValue({ targetType: r.target_type ?? 'user', targetId: r.target_id??fixedUser, window: r.window ?? 'month', windowHours: r.window_hours ?? 5, tokenLimit: r.token_limit ?? null, costLimit: r.cost_limit ?? null, currency: r.currency ?? 'CNY', rpm: r.rpm ?? null, concurrency: r.concurrency ?? null, action: r.action ?? 'block', enabled: r.enabled === undefined ? true : !!r.enabled }); };
    const targetName = (q: any) => q.target_type === 'org' ? '整个组织' : q.target_type === 'user' ? users.find(u => u.id === q.target_id)?.displayName ?? q.target_id : q.target_type === 'department' ? groups.find(g => g.id === q.target_id)?.name ?? q.target_id : keys.find(k => k.id === q.target_id)?.name ?? q.target_id;
    return <Space direction="vertical" size={16} style={{ width: '100%' }}><RemoteError {...r}/><Alert showIcon type="info" message="多个范围的规则同时生效；留空表示不限额，0 表示禁止。Token 额度采用预留与结算控制，预留量为估算值；实际用量完整记录。" description="缺失用量保留待核对预留。费用限额只允许已配置价格且币种一致的调用；日期周期使用北京时间。"/>
 <div className="echo-section-top"><Button type="primary" icon={<PlusOutlined />} onClick={() => edit({ id: 'new' })}>新增配额</Button><Refresh {...r}/></div>
 <Table scroll={{ x: 900 }} rowKey="id" loading={r.loading} dataSource={(r.data??[]).filter(q=>!fixedUser||q.target_type==='org'||q.target_type==='user'&&q.target_id===fixedUser||q.target_type==='department'&&q.target_id===users.find(u=>u.id===fixedUser)?.departmentId||q.target_type==='key'&&keys.some(k=>k.id===q.target_id&&k.userId===fixedUser))} columns={[{ title: '对象', render: (_: unknown, q: any) => <Space direction="vertical" size={0}><strong>{targetName(q)}</strong><small>{({ org: '组织', department: '部门', user: '用户', key: '密钥' } as any)[q.target_type]}</small></Space> }, { title: '周期', render: (_: unknown, q: any) => q.window === 'rolling' ? `滚动 ${q.window_hours} 小时` : q.window === 'day' ? '每日' : '每月' }, { title: 'Token / 限额', render: (_: unknown, q: any) => <div>{number(q.usage.tokens)} / {q.token_limit === null ? '不限' : number(q.token_limit)}{q.token_limit !== null && <Progress size="small" percent={Math.min(100, Math.round(q.usage.tokens / Math.max(1, q.token_limit) * 100))} showInfo={false}/>}</div> }, { title: '费用 / 限额', render: (_: unknown, q: any) => `${q.currency} ${q.usage.cost.toFixed(4)} / ${q.cost_limit ?? '不限'}` }, { title: 'RPM / 并发', render: (_: unknown, q: any) => `${q.rpm ?? '不限'} / ${q.concurrency ?? '不限'}` }, { title: '策略', render: (_: unknown, q: any) => <Tag color={!q.enabled ? 'default' : q.action === 'warn' ? 'warning' : 'success'}>{!q.enabled ? '已停用' : q.action === 'warn' ? '仅提醒' : '超额拦截'}</Tag> }, ...[{ title: '操作', width: 180, render: (_: unknown, q: any) => fixedUser&&q.target_type!=='user'?<Tag>继承的规则</Tag>:<Space><Button type="link" onClick={() => edit(q)}>编辑</Button><Popconfirm title="删除此规则？" onConfirm={async () => { try {
                    await ops.deleteQuota(q.id);
                    void r.reload();
                }
                catch { } }}><Button type="link" danger>删除</Button></Popconfirm></Space> }]]}/>
 <Modal open={!!editing} title="设置配额" confirmLoading={saving} onCancel={() => setEditing(null)} onOk={() => form.submit()}><Form form={form} layout="vertical" onFinish={async (v) => { setSaving(true); try {
        await ops.putQuota(editing.id, { ...v, targetId: v.targetType === 'org' ? 'all' : v.targetId });
        message.success('配额已保存');
        setEditing(null);
        void r.reload();
    }
    catch { }
    finally {
        setSaving(false);
    } }}><Row gutter={16}><Col span={10}><Form.Item name="targetType" label="对象类型" rules={[{ required: true }]}><Select disabled={!!fixedUser} onChange={() => form.setFieldValue('targetId', undefined)} options={[{ value: 'org', label: '整个组织' }, { value: 'department', label: '部门' }, { value: 'user', label: '用户' }, { value: 'key', label: '密钥' }]}/></Form.Item></Col><Col span={14}>{type !== 'org' && <Form.Item name="targetId" label="对象" rules={[{ required: true }]}><Select disabled={!!fixedUser} showSearch optionFilterProp="label" options={(type === 'user' ? users : type === 'department' ? groups : keys).map((x: any) => ({ value: x.id, label: x.displayName ?? x.name }))}/></Form.Item>}</Col></Row><Row gutter={16}><Col span={12}><Form.Item name="window" label="周期"><Select options={[{ value: 'day', label: '每日' }, { value: 'month', label: '每月' }, { value: 'rolling', label: '滚动窗口' }]}/></Form.Item></Col><Col span={12}><Form.Item noStyle shouldUpdate>{() => form.getFieldValue('window') === 'rolling' && <Form.Item name="windowHours" label="窗口小时"><InputNumber min={1} max={8760}/></Form.Item>}</Form.Item></Col></Row><Form.Item name="tokenLimit" label="Token 限额" extra="留空不限额，0 表示禁止新调用"><InputNumber min={0} precision={0} style={{width:'100%'}} placeholder="不限"/></Form.Item><Collapse style={{marginBottom:16}} items={[{key:'advanced',label:'高级：费用、请求频率与并发限制',forceRender:true,children:<Row gutter={16}><Col span={12}><Form.Item name="costLimit" label="费用限额"><InputNumber min={0} style={{width:'100%'}} placeholder="不限"/></Form.Item></Col><Col span={12}><Form.Item name="currency" label="币种"><Select options={[{value:'CNY',label:'人民币'},{value:'USD',label:'美元'}]}/></Form.Item></Col><Col span={12}><Form.Item name="rpm" label="每分钟请求数"><InputNumber min={0} precision={0} placeholder="不限"/></Form.Item></Col><Col span={12}><Form.Item name="concurrency" label="并发调用数"><InputNumber min={0} precision={0} placeholder="不限"/></Form.Item></Col><Col span={24}><Form.Item name="action" label="超额处理"><Select options={[{value:'block',label:'拦截新调用'},{value:'warn',label:'仅提醒'}]}/></Form.Item></Col></Row>} ]}/><Form.Item name="enabled" valuePropName="checked" label="启用规则"><Switch /></Form.Item></Form></Modal>
 </Space>;
}
export function Jobs() {
    const [search]=useSearchParams();
    const [page, setPage] = useState(1), [state, setState] = useState<string|undefined>(search.get('state')??undefined), r = useRemote(() => ops.getJobs({ page, state }), [page, state]);
    return <Space direction="vertical" size={16} style={{ width: '100%' }}><RemoteError {...r}/><div className="echo-section-top"><Select allowClear placeholder="全部任务状态" value={state} style={{ width: 180 }} onChange={v => { setState(v); setPage(1); }} options={[['queued', '排队中'], ['running', '处理中'], ['failed', '失败'], ['done', '完成']].map(([value, label]) => ({ value, label }))}/><Refresh {...r}/></div><Alert showIcon type="info" message="失败任务可从头重试；新版本完成前，已有可用版本继续提供检索。"/><Table scroll={{ x: 800 }} rowKey="id" loading={r.loading} dataSource={r.data?.items ?? []} pagination={{ current: page, pageSize: 25, total: r.data?.total ?? 0, onChange: setPage, showSizeChanger: false }} columns={[{ title: '文档', dataIndex: 'title' }, { title: '阶段', dataIndex: 'stage', render: (v: string) => ({ parse: '解析', chunk: '分块', embed: '嵌入', finalize: '完成校验' } as any)[v] ?? v }, { title: '状态', dataIndex: 'state', render: (v: string) => <Tag color={v === 'failed' ? 'error' : v === 'done' ? 'success' : 'processing'}>{({ queued: '排队中', running: '处理中', failed: '失败', done: '完成' } as any)[v]}</Tag> }, { title: '已尝试', dataIndex: 'attempts', width: 80 }, { title: '错误原因', dataIndex: 'lastError', ellipsis: true }, { title: '更新时间', dataIndex: 'updatedAt', render: fmtTime }, { title: '', width: 90, render: (_: unknown, j: any) => j.state === 'failed' && <Button type="link" onClick={async () => { try {
                await ops.retryJob(j.id);
                message.success('已重新入队');
                void r.reload();
            }
            catch { } }}>重试</Button> }]}/></Space>;
}
export function Clients() {
    const r=useRemote(ops.getDevices);
    useEffect(()=>{const timer=setInterval(()=>void r.reload(),30000);return()=>clearInterval(timer)},[r.reload]);
    return <Space direction="vertical" style={{width:'100%'}} size={16}><RemoteError {...r}/><div className="echo-section-top"><span>设备联系与配置应用</span><Refresh {...r}/></div><DeviceTable items={r.data?.items??[]} loading={r.loading} reload={r.reload} policyVersion={r.data?.policyVersion} configRevision={r.data?.configRevision}/></Space>;
}
export function Skills() {
    const [source, setSource] = useState<any>(null), [sourceBusy, setSourceBusy] = useState(false);
    const readSource = async (skillId: string, versionId: string, path?: string) => { setSourceBusy(true); try {
        const s: any = await client.get(`/api/v1/admin/skills/${skillId}/versions/${versionId}/source`, { params: { path } });
        setSource({ ...s, skillId, versionId });
    }
    catch { }
    finally {
        setSourceBusy(false);
    } };
    const r = useRemote(ops.getSkills), [keyword, setKeyword] = useState(''), [detail, setDetail] = useState<any>(null), [versions, setVersions] = useState<any[]>([]), [loading, setLoading] = useState(false), [action, setAction] = useState<any>(null), [note, setNote] = useState('');
    const open = async (s: any) => { setDetail(s); setLoading(true); try {
        setVersions(await ops.getSkillVersions(s.id));
    }
    catch {
        setVersions([]);
    }
    finally {
        setLoading(false);
    } };
    return <Space direction="vertical" size={16} style={{ width: '100%' }}><RemoteError {...r}/><div className="echo-section-top"><Input.Search allowClear placeholder="搜索技能名称或说明" style={{ width: 300 }} onSearch={setKeyword}/><Refresh {...r}/></div><Table scroll={{ x: 780 }} rowKey="id" dataSource={(r.data ?? []).filter(s => `${s.name} ${s.description}`.toLowerCase().includes(keyword.toLowerCase()))} loading={r.loading} columns={[{ title: '技能', render: (_: unknown, s: any) => <Button type="link" onClick={() => void open(s)}>{s.name}</Button> }, { title: '范围', dataIndex: 'scopeName' }, { title: '当前版本', dataIndex: 'version', render: (v: string) => v ?? '尚未发布' }, { title: '分发策略', render: (_: unknown, s: any) => <Space><Tag>{s.mandatory ? '组织必装' : '成员可选'}</Tag>{!s.allowPersonalOverride && <Tag>禁止个人覆盖</Tag>}</Space> }, { title: '状态', dataIndex: 'state', render: (s: string, row: any) => <Tag color={s === 'active' && row.version ? 'success' : 'default'}>{!row.version ? '未发布' : s === 'active' ? '有效' : '已停用'}</Tag> }, { title: '调用 / 失败', render: (_: unknown, s: any) => `${s.uses} / ${s.failures}` }, { title: '', width: 200, render: (_: unknown, s: any) => <Space><Button type="link" onClick={() => void open(s)}>详情</Button><Button type="link" onClick={() => { setNote(''); setAction({ type: 'policy', skill: s, mandatory: !!s.mandatory, allowPersonalOverride: !!s.allowPersonalOverride }); }}>策略</Button>{s.state === 'active' && <Button type="link" danger onClick={() => { setNote(''); setAction({ type: 'disable', skill: s }); }}>停用</Button>}</Space> }]}/>
 <Drawer open={!!detail} title={detail?.name ?? '技能详情'} onClose={() => setDetail(null)} width={680}><p>{detail?.description}</p><Tabs items={[{ key: 'versions', label: '版本与扫描', children: <Table rowKey="versionId" loading={loading} dataSource={versions} pagination={false} columns={[{ title: '版本', dataIndex: 'version' }, { title: '状态', dataIndex: 'state',render:(s:string)=><Tag>{({pending:'自动检查中',approved:'已发布',rejected:'未发布',revoked:'已停用'} as Record<string,string>)[s]??s}</Tag> }, { title: '扫描', dataIndex: 'scanStatus', render: (v: string) => <Tag color={v === 'passed' ? 'success' : 'error'}>{v === 'passed' ? '通过' : v}</Tag> }, { title: '说明', dataIndex: 'changelog' }, { title: '文件', render: (_: unknown, v: any) => <Button type="link" loading={sourceBusy} onClick={() => void readSource(detail.id, v.versionId)}>查看文件</Button> }, { title:'下载',render:(_:unknown,v:any)=><Button type="link" onClick={()=>void client.get(`/api/v1/admin/skill-submissions/${v.versionId}/package`,{responseType:'blob'}).then((b:any)=>ops.downloadBlob(b,`${detail.name}-${v.version}.zip`)).catch(()=>{})}>下载包</Button> }, { title: '', render: (_: unknown, v: any) => v.state === 'approved' && v.versionId !== detail?.versionId && <Button type="link" onClick={() => { setNote(''); setAction({ type: 'rollback', skill: detail, version: v }); }}>设为当前</Button> }]} expandable={{ expandedRowRender: (v: any) => <ScanReport report={parseJson(v.scanReportJson)}/> }}/> }, { key: 'manifest', label: '文件清单', children: <Table rowKey="path" pagination={{pageSize:15}} dataSource={parseJson(detail?.manifestJson).files??[]} columns={[{title:'文件',dataIndex:'path'},{title:'大小',dataIndex:'bytes',render:(n:number)=>n==null?'—':`${n.toLocaleString('zh-CN')} B`}]}/> }]}/></Drawer>
 <Modal title={action?.type === 'disable' ? '停用技能' : action?.type === 'policy' ? '技能分发策略' : '回退技能版本'} open={!!action} onCancel={() => setAction(null)} onOk={async () => { if (!note.trim()) {
        message.warning('请填写原因');
        return;
    } try {
        if (action.type === 'disable')
            await ops.disableSkill(action.skill.id, note);
        else if (action.type === 'policy')
            await client.patch(`/api/v1/admin/skills/${action.skill.id}/policy`, { mandatory: action.mandatory, allowPersonalOverride: action.allowPersonalOverride, note });
        else
            await ops.rollbackSkill(action.skill.id, action.version.versionId, note);
        setAction(null);
        setDetail(null);
        void r.reload();
        message.success('已发布变更，客户端应用情况可在客户端状态中查看');
    }
    catch { } }}>{action?.type === 'policy' && <Space direction="vertical"><Space>组织必装 <Switch checked={action.mandatory} onChange={v => setAction({ ...action, mandatory: v })}/></Space><Space>允许个人覆盖 <Switch checked={action.allowPersonalOverride} onChange={v => setAction({ ...action, allowPersonalOverride: v })}/></Space></Space>}<p>变更将影响后续分发；离线设备在重新连接或租约到期后应用。</p><Input.TextArea aria-label="变更原因" value={note} onChange={e => setNote(e.target.value)} placeholder="请说明变更原因" maxLength={2000}/></Modal>
 <Modal title="技能文件预览" open={!!source} width={800} onCancel={() => setSource(null)} footer={null}><Space direction="vertical" style={{ width: '100%' }}><Select style={{ width: '100%' }} value={source?.path} loading={sourceBusy} onChange={path => void readSource(source.skillId, source.versionId, path)} options={(source?.files ?? []).map((p: string) => ({ value: p, label: p }))}/>{source?.truncated && <Alert type="info" message="大文件仅预览前 200 KB"/>}<pre className="echo-json">{source?.text ?? source?.reason ?? ''}</pre></Space></Modal>
 </Space>;
}
export function Maintenance() { return <MaintenanceList/>; }
export function System() {
    const r = useRemote(ops.getSystem), [busy, setBusy] = useState(false);
    return <Space direction="vertical" size={16} style={{ width: '100%' }}><RemoteError {...r}/><div className="echo-section-top"><span>运行状态与完整备份</span><Refresh {...r}/></div>{r.data && <><Row gutter={[16, 16]}><Col xs={24} xl={12}><Card title="运行能力"><Descriptions column={1} items={Object.entries(r.data.capabilities).map(([key, value]) => ({ key, label: key, children: <Tag color={value ? 'success' : 'warning'}>{value ? '已配置' : '未配置'}</Tag> }))}/></Card></Col><Col xs={24} xl={12}><Card title="数据状态"><Descriptions column={1} items={[{key:'backup-frequency',label:'数据库自动快照',children:r.data.backup?.intervalHours?`每 ${r.data.backup.intervalHours} 小时 · 保留 ${r.data.backup.retention} 份`:'未启用周期快照'},{key:'latest-backup',label:'最近数据库快照',children:r.data.backup?.latest?fmtTime(r.data.backup.latest.createdAt):'尚无快照记录'},{key:'latest-full',label:'最近完整备份生成',children:fmtTime(r.data.backup?.lastFullGeneratedAt)},{ key: 'schema', label: '数据库版本', children: r.data.schemaVersion }, { key: 'assets', label: '原始文件', children: `${r.data.assets} 个` }, { key: 'ledger', label: '调用账本', children: `${r.data.calls} 条` }, { key: 'unknown', label: '待核对调用', children: r.data.unsettled }]}/><Popconfirm title="生成完整备份？" description="备份包含数据库与原始资产，请安全保存；恢复时需要原服务器主密钥。" onConfirm={async () => { setBusy(true); try {
        ops.downloadBlob(await ops.backupSystem(), `Echo-完整备份-${new Date().toISOString().slice(0, 10)}.zip`);
        message.success('完整备份已生成');void r.reload();
    }
    catch { }
    finally {
        setBusy(false);
    } }}><Button type="primary" icon={<DownloadOutlined />} loading={busy}>下载完整备份</Button></Popconfirm></Card></Col></Row><p className="echo-help">数据库自动快照只包含数据库；完整备份包含数据库和原始资产。下载后请存放到独立位置，恢复仍需保留原服务器主密钥，并使用项目恢复工具校验。</p>{r.data.backup?.readable===false&&<Alert type="error" showIcon message="备份目录无法读取，请检查持久化存储和权限"/>}</>}</Space>;
}
