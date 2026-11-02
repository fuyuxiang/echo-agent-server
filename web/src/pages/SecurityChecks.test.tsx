import {beforeEach,describe,expect,it,vi} from 'vitest'
import {fireEvent,render,screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import client from '../api/client'
import SecurityChecks from './SecurityChecks'
vi.mock('../api/client',()=>({default:{get:vi.fn(),post:vi.fn()}}))
beforeEach(()=>vi.resetAllMocks())
describe('automatic safety checks',()=>{
 it('shows the risk and isolation result without human approval actions',async()=>{
  vi.mocked(client.get).mockResolvedValue({items:[{id:'one',kind:'skill',title:'危险技能',state:'rejected',scan_status:'failed',created_at:1,scanReport:{status:'failed',findings:[{code:'SKILL_DANGEROUS_COMMAND',message:'破坏性命令'}]}}],total:1,summary:{total:1,processing:0,failed:1,published:0}})
  render(<MemoryRouter><SecurityChecks/></MemoryRouter>)
  expect(await screen.findByText('危险技能')).toBeInTheDocument()
  expect(screen.queryByRole('button',{name:/审核通过|批准|退回/})).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:/检查详情/}))
  expect(await screen.findByText(/SKILL_DANGEROUS_COMMAND/)).toBeInTheDocument()
  vi.mocked(client.post).mockResolvedValue({state:'rejected',scanStatus:'failed',message:'危险命令仍被拦截'})
  fireEvent.click(screen.getByRole('button',{name:/重新执行安全检查/}))
  expect(await screen.findByText('危险命令仍被拦截')).toBeInTheDocument()
  expect(client.post).toHaveBeenCalledWith('/api/v1/admin/security-checks/skill/one/retry')
 })
 it('uses the document filter in the embedded document checks view',async()=>{
  vi.mocked(client.get).mockResolvedValue({items:[],total:0,summary:{total:0,processing:0,failed:0,published:0}})
  render(<MemoryRouter><SecurityChecks defaultKind="document"/></MemoryRouter>)
  expect(await screen.findByText('检查记录')).toBeInTheDocument()
  expect(client.get).toHaveBeenCalledWith('/api/v1/admin/security-checks',{params:{kind:'document',status:undefined,page:1}})
 })
})
