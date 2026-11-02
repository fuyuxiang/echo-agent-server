import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Credentials, Workspace, Usage } from './Operations'
import * as ops from '../api/operations'
import { clearAuth, saveAuth } from '../store/auth'
vi.mock('../api/operations',()=>({getKeys:vi.fn(),createKey:vi.fn(),getWorkspace:vi.fn(),getUsage:vi.fn()}))
vi.mock('../api',()=>({listUsers:vi.fn(async()=>[]),listGroups:vi.fn(async()=>[])}))
beforeEach(()=>{
 vi.resetAllMocks();clearAuth();saveAuth({accessToken:'test',refreshToken:'test',user:{id:'u',username:'admin',displayName:'管理员',role:'admin',clearance:0,groups:[],scopes:[]}})
})
describe('new administration workflows',()=>{
 it('shows a recoverable loading error and can retry without losing the page',async()=>{
  vi.mocked(ops.getKeys).mockRejectedValueOnce(new Error('临时离线')).mockResolvedValueOnce({items:[],baseUrl:'https://server/api/v1/llm/v1'})
  render(<Credentials/>);expect(await screen.findByText('暂时无法加载')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:/重\s*试/}))
  expect(await screen.findByText('https://server/api/v1/llm/v1')).toBeInTheDocument()
  await waitFor(()=>expect(screen.queryByText('暂时无法加载')).not.toBeInTheDocument())
 })
 it('requires an explicit recipient instead of silently assigning a key to the administrator',async()=>{
  vi.mocked(ops.getKeys).mockResolvedValue({items:[],baseUrl:'https://server/api/v1/llm/v1'})
  render(<Credentials/>);fireEvent.click(await screen.findByRole('button',{name:/创建密钥/}))
  expect(screen.getByText('分配给用户')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('用途名称'),{target:{value:'研发设备'}})
  fireEvent.click(screen.getByRole('button',{name:/确\s*定|OK/}))
  expect(await screen.findByText('请选择密钥所属用户')).toBeInTheDocument()
  expect(ops.createKey).not.toHaveBeenCalled()
  expect(screen.getByLabelText('用途名称')).toBeInTheDocument()
 })
 it('shows actual usage and unresolved accounting separately for the organization',async()=>{
  vi.mocked(ops.getUsage).mockResolvedValue({summary:{totalTokens:1234,inputTokens:1000,outputTokens:234,calls:2,unsettled:1},costs:[],rankings:[{userId:'u',username:'member',displayName:'成员',totalTokens:1234,inputTokens:1000,outputTokens:234,calls:2,unsettled:1}],departments:[],sources:[],trend:[],items:[],updatedAt:Date.now()})
  render(<Usage/>);expect(await screen.findByText('未完整结算')).toBeInTheDocument()
  expect(screen.getByText('全部用户')).toBeInTheDocument()
  expect(screen.getByText('尚无可估算费用',{exact:false})).toBeInTheDocument()
 })
 it('shows automatic safety work without a human approval task',async()=>{
  vi.mocked(ops.getWorkspace).mockResolvedValue({documents:{ready:0,failed:0},memories:{total:0,expired:0},pending:{memories:1,documents:2,skills:3},recent:[],operations:{activeUsers:2,failedJobs:0,unsettledCalls:0,openMaintenance:0,safetyPending:6,safetyFailed:0}})
  render(<MemoryRouter><Workspace/></MemoryRouter>)
  expect((await screen.findAllByText('6')).length).toBeGreaterThan(0)
  expect(screen.queryByText('待办审核')).not.toBeInTheDocument()
  expect(screen.queryByText('我的提交')).not.toBeInTheDocument()
  expect(screen.queryByText('通知中心')).not.toBeInTheDocument()
  expect(screen.getByText('管理快捷入口')).toBeInTheDocument()
 })
})
