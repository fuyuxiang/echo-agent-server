import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Col, Descriptions, Drawer, Form, Input, Modal, Row, Select, Space, Statistic, Table, Tag, message } from 'antd'
import { Link, useSearchParams } from 'react-router-dom'
import client from '../api/client'
import ScanReport from '../components/ScanReport'
import { fmtTime } from '../utils/format'
const kinds:Record<string,string>={document:'文档',skill:'技能',promotion:'经验与文本知识'}
const statuses:Record<string,string>={queued:'排队中',scanning:'检查中',passed:'通过',failed:'未通过',unknown:'历史记录'}
export default function SecurityChecks({defaultKind,assetId}:{defaultKind?:string,assetId?:string}){
 const [params]=useSearchParams(),[kind,setKind]=useState<string|undefined>(defaultKind),[status,setStatus]=useState<string|undefined>(params.get('status')??undefined),[view,setView]=useState(defaultKind?'all':params.get('view')??'attention'),[page,setPage]=useState(1)
 const [data,setData]=useState<any>(null),[loading,setLoading]=useState(false),[error,setError]=useState(false),[detail,setDetail]=useState<any>(null),[busy,setBusy]=useState(false),[disposition,setDisposition]=useState<string|null>(null),[form]=Form.useForm(),seq=useRef(0)
 useEffect(()=>{if(!defaultKind){setView(params.get('view')??'attention');setStatus(params.get('status')??undefined);setPage(1)}},[params,defaultKind])
 const load=useCallback(async()=>{const n=++seq.current;setLoading(true);setError(false);try{const result=await client.get('/api/v1/admin/security-checks',{params:{kind,status,view,page,assetId}});if(n===seq.current)setData(result)}catch{if(n===seq.current)setError(true)}finally{if(n===seq.current)setLoading(false)}},[kind,status,view,page,assetId])
 useEffect(()=>{void load();return()=>{seq.current++}},[load])
 useEffect(()=>{if(!data?.summary.processing)return;const timer=setInterval(()=>void load(),5000);return()=>clearInterval(timer)},[data?.summary.processing,load])
 const publication=(r:any)=>r.state==='approved'?'已发布':r.state==='pending'?'自动处理中':r.state==='rejected'?'已阻止发布':r.state==='withdrawn'?'已撤回':'已停用'
 const dispositionLabel=(r:any)=>r.state==='pending'?(r.requiresAttention?'检查服务需恢复':'自动处理中'):r.scan_status==='failed'?({follow_up:'待跟进',handled:'已隔离',archived:'已归档'} as any)[r.disposition??'handled']:'—'
 const assetLink=(r:any)=>r.asset_id?(r.asset_kind==='document'?`/documents?docId=${r.asset_id}`:r.asset_kind==='memory'?`/memories?memoryId=${r.asset_id}`:'/skills'):null
 return <Space direction="vertical" size={16} style={{width:'100%'}}>
  <p className="echo-help">共享内容通过安全检查后自动发布。已拦截内容保持隔离；归档检查记录不会放行内容，也不会中断检查服务故障的自动重试。</p>
  {error&&<Alert type="error" message="检查记录加载失败" action={<Button onClick={()=>void load()}>重试</Button>}/>}
  {data&&!assetId&&<Row className="echo-metrics" gutter={[16,16]}>{[['需要恢复 / 跟进',data.summary.attention??0],['自动处理中',data.summary.processing??0],['已隔离',data.summary.isolated??0],['已发布',data.summary.published??0]].map(([title,value])=><Col key={title} xs={12} xl={6}><Card><Statistic title={title} value={value}/></Card></Col>)}</Row>}
  <div className="echo-section-top"><Space wrap><Select aria-label="处置范围" style={{width:160}} value={view} onChange={v=>{setView(v);setPage(1)}} options={[{value:'attention',label:'需要恢复或跟进'},{value:'isolated',label:'已隔离记录'},{value:'all',label:'全部检查记录'},{value:'archived',label:'已归档记录'}]}/>{!defaultKind&&<Select allowClear placeholder="全部内容类型" style={{width:160}} value={kind} onChange={v=>{setKind(v);setPage(1)}} options={Object.entries(kinds).map(([value,label])=>({value,label}))}/>}<Select allowClear placeholder="全部检查状态" style={{width:150}} value={status} onChange={v=>{setStatus(v);setPage(1)}} options={Object.entries(statuses).map(([value,label])=>({value,label}))}/></Space><Button loading={loading} onClick={()=>void load()}>刷新</Button></div>
  <Table rowKey={r=>`${r.kind}-${r.id}`} scroll={{x:900}} loading={loading} dataSource={data?.items??[]} locale={{emptyText:view==='attention'?'当前没有需要恢复或跟进的安全异常':assetId?'此文档暂无独立检查记录，可查看版本与处理记录':'暂无符合条件的检查记录'}} pagination={{current:page,pageSize:25,total:data?.total??0,onChange:setPage,showSizeChanger:false}} columns={[
   {title:'内容',render:(_:unknown,r:any)=><Space direction="vertical" size={0}><strong>{r.title}</strong><small className="echo-muted">{kinds[r.kind]}</small></Space>},
   {title:'提交人',render:(_:unknown,r:any)=><Link to={`/users/${r.submitter_id}`}>{r.submitterName}</Link>},{title:'范围',dataIndex:'scopeName'},
   {title:'安全检查',dataIndex:'scan_status',render:(s:string)=><Tag color={s==='passed'?'success':s==='failed'?'error':'default'}>{statuses[s]??s}</Tag>},
   {title:'处置状态',render:(_:unknown,r:any)=>dispositionLabel(r)}, {title:'提交时间',dataIndex:'created_at',render:fmtTime},
   {title:'',render:(_:unknown,r:any)=><Button type="link" onClick={()=>setDetail(r)}>检查详情</Button>}
  ]}/>
  <Drawer title="安全检查与处置" open={!!detail} onClose={()=>setDetail(null)} width={680}>{detail&&<Space direction="vertical" size={20} style={{width:'100%'}}>
   <Descriptions bordered size="small" column={1} items={[{key:'title',label:'内容',children:detail.title},{key:'state',label:'发布状态',children:publication(detail)},{key:'disposition',label:'处置状态',children:dispositionLabel(detail)},{key:'retry',label:'计划自动重试',children:fmtTime(detail.auto_retry_at)},{key:'note',label:'处置说明',children:detail.dispositionNote??detail.review_note??'—'}]}/>
   {assetLink(detail)&&<Link to={assetLink(detail)!}>查看关联知识</Link>}
   <ScanReport report={detail.scanReport}/>
   {['pending','rejected'].includes(detail.state)&&<Button loading={busy} onClick={async()=>{setBusy(true);try{const result:any=await client.post(`/api/v1/admin/security-checks/${detail.kind}/${detail.id}/retry`);message.info(result.state==='approved'?'检查通过，已自动发布':result.message??'检查未通过，内容继续隔离');setDetail(null);await load()}catch{}finally{setBusy(false)}}}>重新执行安全检查</Button>}
   {detail.scan_status==='failed'&&detail.state!=='pending'&&<Space wrap>{[['follow_up','标记待跟进'],['handled','确认已隔离'],['archived','归档记录']].filter(([key])=>key!==detail.disposition).map(([key,label])=><Button key={key} onClick={()=>{form.resetFields();setDisposition(key)}}>{label}</Button>)}</Space>}
  </Space>}</Drawer>
  <Modal title="记录安全处置" open={!!disposition} onCancel={()=>setDisposition(null)} confirmLoading={busy} onOk={()=>form.submit()}><Form form={form} layout="vertical" onFinish={async values=>{setBusy(true);try{await client.post(`/api/v1/admin/security-checks/${detail.kind}/${detail.id}/disposition`,{status:disposition,note:values.note});message.success('处置已记录，内容隔离状态保持');setDisposition(null);setDetail(null);await load()}catch{}finally{setBusy(false)}}}><p className="echo-help">这里只管理检查记录，不改变安全检查结果或发布权限。</p><Form.Item name="note" label="处置说明" rules={[{required:true,min:2,message:'请填写至少 2 个字符的处置说明'}]}><Input.TextArea rows={3} maxLength={2000}/></Form.Item></Form></Modal>
 </Space>
}
