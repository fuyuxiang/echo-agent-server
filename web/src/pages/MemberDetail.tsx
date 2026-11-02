import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Descriptions, Empty, Row, Space, Spin, Statistic, Steps, Tabs, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, EditOutlined, ReloadOutlined } from '@ant-design/icons'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import client from '../api/client'
import * as api from '../api'
import { getUser } from '../store/auth'
import { EditModal } from './Users'
import { Credentials, Quotas, Usage } from './Operations'
import DeviceTable from '../components/DeviceTable'
import type { Group } from '../types'

export default function MemberDetail(){
 const {id}=useParams(),[search,setSearch]=useSearchParams(),[data,setData]=useState<any>(null),[groups,setGroups]=useState<Group[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(false),[editing,setEditing]=useState(false)
 const load=useCallback(async()=>{setLoading(true);setError(false);try{const [detail,groups]=await Promise.all([client.get(`/api/v1/admin/users/${id}/overview`),api.listGroups()]);setData(detail);setGroups(groups)}catch{setError(true)}finally{setLoading(false)}},[id])
 useEffect(()=>{void load()},[load])
 useEffect(()=>{if(editing||search.get('tab')!=='devices')return;const timer=setInterval(()=>void load(),30000);return()=>clearInterval(timer)},[load,editing,search]);
 if(loading&&!data)return <Spin/>
 if(error&&!data)return <Alert type="error" message="成员详情加载失败，或该成员已不存在" action={<Button onClick={()=>void load()}>重试</Button>}/>
 if(!data)return <Empty/>
 const user=data.user,tab=search.get('tab')??'permissions'
 const firstContact=data.devices.length>0,modelSynced=data.devices.some((x:any)=>x.configRevision===data.configRevision),reported=data.coverage.reported>0
 return <Space direction="vertical" size={20} style={{width:'100%'}}>
  <div className="echo-member-heading"><Space direction="vertical"><Link to="/users"><ArrowLeftOutlined/> 返回成员列表</Link><div><h2>{user.displayName} <Tag>{user.username}</Tag><Tag color={user.status==='active'?'success':'default'}>{user.status==='active'?'账号启用':'账号禁用'}</Tag></h2><span className="echo-muted">{user.departmentName??'未设置主归属部门'} · {({admin:'管理员',curator:'知识维护',member:'成员'} as any)[user.role]}</span></div></Space><Space><Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>刷新</Button><Button type="primary" icon={<EditOutlined/>} onClick={()=>setEditing(true)}>编辑成员与权限</Button></Space></div>
  {error&&<Alert type="error" message="刷新失败，当前显示的是上次加载的数据" action={<Button onClick={()=>void load()}>重试</Button>}/>}
  <Row gutter={[16,16]} className="echo-metrics">{[['近 30 天实际 Token',data.summary.calls&&data.summary.knownCalls===0?'—':data.summary.totalTokens.toLocaleString('zh-CN')],['成功 / 总调用',`${data.summary.successfulCalls} / ${data.summary.calls}`],['待核对调用',data.summary.unsettled],['设备上报',`${data.coverage.reported} / ${data.coverage.total}`]].map(([title,value])=><Col xs={12} xl={6} key={title}><Card><Statistic title={title} value={value}/></Card></Col>)}</Row>
  {(search.get('welcome')==='1'||!firstContact)&&<Card title="客户端接入指引" className="echo-status-card">
   <Typography.Paragraph>在 Echo Agent 桌面端的组织设置中填写以下服务器地址，使用账号 <strong>{user.username}</strong> 和管理员分配的密码登录。模型地址与个人访问密钥会自动同步。</Typography.Paragraph>
   <Typography.Paragraph copyable>{data.serverUrl}</Typography.Paragraph>
   <Steps size="small" style={{marginTop:20}} items={[{title:'账号已创建',status:'finish'},{title:'客户端首次联系',status:firstContact?'finish':'wait'},{title:'模型配置已应用',status:modelSynced?'finish':'wait'},{title:'设备回执已上报',status:reported?'finish':'wait'}]}/>
   <p className="echo-help">联系记录与应用回执分别确认；旧版客户端的“未上报”不会视为接入失败。</p>
  </Card>}
  <Tabs activeKey={tab} onChange={key=>setSearch({tab:key})} destroyOnHidden items={[
   {key:'permissions',label:'权限与接入',children:<Space direction="vertical" size={16} style={{width:'100%'}}><Descriptions bordered column={1} items={[{key:'role',label:'账号权限',children:user.role==='admin'?'可登录管理端；同时可使用桌面端':'使用桌面端；管理端仅管理员可登录'},{key:'clearance',label:'可访问密级',children:['组织内公开','内部','机密'][user.clearance]},{key:'department',label:'主归属部门',children:user.departmentName??'未分配'},{key:'groups',label:'知识访问分组',children:user.groups?.length?user.groups.map((g:any)=><Tag key={g.id}>{g.name}</Tag>):'未设置访问分组'},{key:'scopes',label:'可见共享知识范围',children:data.scopes.length?data.scopes.map((x:any)=><Tag key={x.id}>{x.name}</Tag>):'暂无'},{key:'base',label:'模型连接地址',children:<Typography.Text copyable>{data.baseUrl}</Typography.Text>}]}/><p className="echo-help">主归属部门用于模型消耗归属；访问分组决定共享知识范围。个人知识不在此后台展示。</p></Space>},
   {key:'usage',label:'模型用量',children:<Usage fixedUser={id}/>},
   {key:'quotas',label:'用量配额',children:<Quotas fixedUser={id}/>},
   {key:'keys',label:'访问密钥',children:<Credentials fixedUser={id}/>},
   {key:'devices',label:'设备与同步',children:<DeviceTable items={data.devices} loading={loading} reload={load} policyVersion={data.policyVersion} configRevision={data.configRevision} showUser={false}/>},
  ]}/>
  <EditModal user={editing?user:null} groups={groups} isSelf={user.id===getUser()?.id} onClose={()=>setEditing(false)} onDone={()=>{setEditing(false);void load()}}/>
 </Space>
}
