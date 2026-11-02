import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Descriptions, Drawer, Row, Select, Space, Statistic, Table, Tag, message } from 'antd'
import { useSearchParams } from 'react-router-dom'
import client from '../api/client'
import { fmtTime } from '../utils/format'
const kinds: Record<string,string> = { document:'文档',skill:'技能',promotion:'经验与文本知识' }
const statuses: Record<string,string> = { queued:'排队中',scanning:'检查中',passed:'通过',failed:'未通过',unknown:'历史记录' }
export default function SecurityChecks({defaultKind}:{defaultKind?:string}) {
  const [params]=useSearchParams()
  const [kind,setKind]=useState<string|undefined>(defaultKind),[status,setStatus]=useState<string|undefined>(params.get('status')==='failed'?'failed':undefined),[page,setPage]=useState(1)
  useEffect(()=>{setStatus(params.get('status')==='failed'?'failed':undefined);setPage(1)},[params.get('status')])
  const [data,setData]=useState<any>(null),[loading,setLoading]=useState(false),[error,setError]=useState(false),[detail,setDetail]=useState<any>(null),[busy,setBusy]=useState(false)
  const load=useCallback(async()=>{setLoading(true);setError(false);try{setData(await client.get('/api/v1/admin/security-checks',{params:{kind,status,page}}))}catch{setError(true)}finally{setLoading(false)}},[kind,status,page])
  useEffect(()=>{void load()},[load])
  useEffect(()=>{if(!data?.summary.processing)return;const timer=setInterval(()=>{void load()},5000);return()=>clearInterval(timer)},[data?.summary.processing,load])
  const publication=(row:any)=> row.state==='approved'?'已发布':row.state==='pending'?(row.scan_status==='failed'?'等待自动重试':'自动处理中'):row.state==='rejected'?'未发布':row.state==='withdrawn'?'已撤回':'已停用'
  return <Space direction="vertical" size={16} style={{width:'100%'}}>
    <Alert showIcon type="info" message="通过安全检查后自动发布，无需人工审批。" description="文档检查病毒与主动内容；技能检查异常包、危险命令、疑似凭证和敏感路径。检查服务不可用时保留隔离并自动重试，执行技能仍受客户端权限控制。" />
    {error&&<Alert type="error" message="检查记录加载失败" action={<Button onClick={()=>void load()}>重试</Button>} />}
    {data&&<Row className="echo-metrics" gutter={[16,16]}>{[['检查记录',data.summary.total],['自动处理中',data.summary.processing??0],['检查未通过',data.summary.failed??0],['已发布',data.summary.published??0]].map(([title,value])=><Col key={title} xs={12} xl={6}><Card><Statistic title={title} value={value}/></Card></Col>)}</Row>}
    <div className="echo-section-top"><Space wrap>{!defaultKind&&<Select allowClear placeholder="全部内容类型" style={{width:180}} value={kind} onChange={v=>{setKind(v);setPage(1)}} options={Object.entries(kinds).map(([value,label])=>({value,label}))}/>}<Select allowClear placeholder="全部检查状态" style={{width:160}} value={status} onChange={v=>{setStatus(v);setPage(1)}} options={Object.entries(statuses).map(([value,label])=>({value,label}))}/></Space><Button loading={loading} onClick={()=>void load()}>刷新</Button></div>
    <Table rowKey={(r:any)=>`${r.kind}-${r.id}`} scroll={{x:900}} loading={loading} dataSource={data?.items??[]} pagination={{current:page,pageSize:25,total:data?.total??0,onChange:setPage,showSizeChanger:false}} columns={[
      {title:'内容',render:(_:unknown,r:any)=><Space direction="vertical" size={0}><strong>{r.title}</strong><small>{kinds[r.kind]}</small></Space>},
      {title:'提交人',dataIndex:'submitterName'},{title:'范围',dataIndex:'scopeName'},
      {title:'安全检查',dataIndex:'scan_status',render:(s:string)=><Tag color={s==='passed'?'success':s==='failed'?'error':'processing'}>{statuses[s]??s}</Tag>},
      {title:'发布状态',render:(_:unknown,r:any)=>publication(r)},
      {title:'提交时间',dataIndex:'created_at',render:fmtTime},
      {title:'',render:(_:unknown,r:any)=><Button type="link" onClick={()=>setDetail(r)}>检查详情</Button>}
    ]}/>
    <Drawer title="安全检查详情" open={!!detail} onClose={()=>setDetail(null)} width={640}>{detail&&<Space direction="vertical" style={{width:'100%'}}><Descriptions bordered size="small" column={1} items={[
      {key:'title',label:'内容',children:detail.title},{key:'type',label:'类型',children:kinds[detail.kind]},{key:'state',label:'发布状态',children:publication(detail)},
      {key:'scanned',label:'检查完成',children:fmtTime(detail.scan_completed_at)},{key:'retry',label:'计划自动重试',children:fmtTime(detail.auto_retry_at)},{key:'note',label:'处理说明',children:detail.review_note??'—'}
    ]}/><Card title="检查引擎与发现"><pre className="echo-json">{detail.scanReport?JSON.stringify(detail.scanReport,null,2):'历史记录未保存安全检查报告'}</pre></Card>{['pending','rejected'].includes(detail.state)&&<Button loading={busy} onClick={async()=>{setBusy(true);try{const result:any=await client.post(`/api/v1/admin/security-checks/${detail.kind}/${detail.id}/retry`);message.info(result.state==='approved'?'安全检查通过，已自动发布':result.message??'检查尚未通过，记录仍未发布');setDetail(null);await load()}catch{}finally{setBusy(false)}}}>重新执行安全检查</Button>}</Space>}</Drawer>
  </Space>
}
