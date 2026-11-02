import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Grid } from 'antd'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ModelConfig from './ModelConfig'
import MemberDetail from './MemberDetail'
import Quality from './Quality'
import DeviceTable from '../components/DeviceTable'
import AppLayout from '../components/AppLayout'
import RouteErrorBoundary from '../components/RouteErrorBoundary'
import * as api from '../api'
import * as ops from '../api/operations'
import client from '../api/client'
import { saveAuth } from '../store/auth'

vi.mock('../api',()=>({getModelConfig:vi.fn(),putModelConfig:vi.fn(),listUsers:vi.fn(),listGroups:vi.fn(),getQuality:vi.fn()}))
vi.mock('../api/operations',()=>({getGatewaySettings:vi.fn(),testModel:vi.fn(),getMaintenance:vi.fn(),getUsage:vi.fn()}))
vi.mock('../api/client',()=>({default:{get:vi.fn(),post:vi.fn()}}))
const renderPage=(element:React.ReactNode,path='/')=>render(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>)
beforeEach(()=>{
 vi.resetAllMocks()
 vi.spyOn(Grid,'useBreakpoint').mockReturnValue({lg:true})
 saveAuth({accessToken:'test',refreshToken:'test',user:{id:'admin',username:'admin',displayName:'管理员',role:'admin',clearance:2,groups:[],scopes:[]}})
 vi.mocked(api.listGroups).mockResolvedValue([]);vi.mocked(api.listUsers).mockResolvedValue([])
 vi.mocked(ops.getGatewaySettings).mockResolvedValue({baseUrl:'https://server/api/v1/llm/v1',publicBaseUrl:'',maxOutputTokens:8192,protocols:['chat'],models:{},inputPrice:null,cachedPrice:null,outputPrice:null,currency:'CNY'})
})
describe('complete administration journeys',()=>{
 it('offers recovery from a failed page without exposing the internal error',()=>{
  const spy=vi.spyOn(console,'error').mockImplementation(()=>{})
  function Broken():React.ReactNode{throw new Error('internal credential context must not be rendered')}
  renderPage(<RouteErrorBoundary><Broken/></RouteErrorBoundary>)
  expect(screen.getByRole('alert')).toHaveTextContent('页面暂时无法显示')
  expect(screen.getByRole('button',{name:'刷新页面'})).toBeInTheDocument()
  expect(screen.queryByText('internal credential context must not be rendered')).not.toBeInTheDocument()
  spy.mockRestore()
 })
 it('keeps five main navigation entries and expands the active member section',async()=>{
  renderPage(<AppLayout/>,'/users')
  expect(screen.getByRole('menuitem',{name:/知识资产/})).toBeInTheDocument()
  expect(screen.getByRole('menuitem',{name:/成员与设备/})).toBeInTheDocument()
  expect(screen.getByRole('menuitem',{name:/模型服务/})).toBeInTheDocument()
  expect(screen.getByRole('menuitem',{name:/系统管理/})).toBeInTheDocument()
  expect(screen.getByRole('menuitem',{name:/成员管理/})).toBeVisible()
  expect(screen.queryByRole('menuitem',{name:'审计日志'})).not.toBeInTheDocument()
 })
 it('saves the edited upstream configuration before testing it and preserves edits when saving fails',async()=>{
  vi.mocked(api.getModelConfig).mockResolvedValue({configured:true,chatProvider:'openai-compatible',chatModel:'original-model',chatBaseUrl:'https://upstream/v1',embedModel:'embed',embedDim:1024,hasCredential:true,proxied:true})
  vi.mocked(api.putModelConfig).mockRejectedValueOnce(new Error('暂时离线')).mockResolvedValueOnce({updated:true} as any)
  vi.mocked(ops.testModel).mockResolvedValue({success:true,message:'成功'})
  renderPage(<ModelConfig/>)
  const input=await screen.findByLabelText('对话模型')
  fireEvent.change(input,{target:{value:'edited-model'}})
  fireEvent.click(screen.getByRole('button',{name:'保存并验证连接'}))
  await waitFor(()=>expect(api.putModelConfig).toHaveBeenCalledTimes(1))
  expect(ops.testModel).not.toHaveBeenCalled();expect(input).toHaveValue('edited-model')
  fireEvent.click(screen.getByRole('button',{name:'保存并验证连接'}))
  await waitFor(()=>expect(ops.testModel).toHaveBeenCalledTimes(1))
  expect(api.putModelConfig).toHaveBeenLastCalledWith(expect.objectContaining({chatModel:'edited-model',embedDim:1024}))
  expect(vi.mocked(api.putModelConfig).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(ops.testModel).mock.invocationCallOrder[0])
 })
 it('shows onboarding and effective shared permissions in a member detail without private assets',async()=>{
  vi.mocked(client.get).mockResolvedValue({user:{id:'alice',username:'alice',displayName:'小林',role:'member',status:'active',clearance:1,groups:[]},summary:{calls:1,knownCalls:0,totalTokens:0,successfulCalls:0,unsettled:1},devices:[],coverage:{total:0,reported:0},scopes:[{id:'org',name:'全公司',kind:'org'}],baseUrl:'https://server/api/v1/llm/v1',serverUrl:'https://server'})
  renderPage(<Routes><Route path="/users/:id" element={<MemberDetail/>}/></Routes>,'/users/alice?welcome=1')
  expect(await screen.findByText('客户端接入指引')).toBeInTheDocument()
  expect(screen.getByText('https://server')).toBeInTheDocument()
  expect(screen.getByText('使用桌面端；管理端仅管理员可登录')).toBeInTheDocument()
  expect(screen.getByText('全公司')).toBeInTheDocument()
  expect(screen.getByText('—')).toBeInTheDocument()
 })
 it('does not show zero negative feedback as satisfaction when no answers or feedback exist',async()=>{
  vi.mocked(api.getQuality).mockResolvedValue({total:0,unansweredRate:0,negativeRate:0,agenticRate:0,feedbackCount:0,feedbackCoverage:0,latency:{avg:null,p50:null,p95:null},blindSpots:[],negativeTop:[],unusedDocs:[],docStats:[],contributions:[]} as any)
  renderPage(<Quality/>)
  expect(await screen.findByText('暂无问答记录')).toBeInTheDocument()
  expect(screen.queryByText('正常')).not.toBeInTheDocument()
  expect(screen.getAllByText('—').length).toBeGreaterThan(2)
 })
 it('shows partial installation failures as readable receipts rather than claiming a complete rollout',async()=>{
  renderPage(<DeviceTable items={[{userId:'alice',deviceId:'dev',displayName:'小林',heartbeatAt:Date.now(),skillReceiptAt:Date.now(),skillReceiptsComplete:0,receiptJson:JSON.stringify([{skillId:'s',versionId:'v',name:'知识复核',version:'1.0',state:'failed',error:'包校验失败'}])}]} loading={false} reload={vi.fn()} />)
  fireEvent.click(screen.getByRole('button',{name:'详情'}))
  expect(await screen.findByText('本次技能同步未完整完成，下列为已确认的部分回执')).toBeInTheDocument()
  expect(screen.getByText('知识复核')).toBeInTheDocument();expect(screen.getByText('安装失败')).toBeInTheDocument()
  expect(screen.getByText('包校验失败')).toBeInTheDocument()
 })
})
