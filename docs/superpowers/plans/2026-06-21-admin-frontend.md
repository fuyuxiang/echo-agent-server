# Echo Agent Server 管理后台前端 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 echo-agent-server 构建 React + Ant Design 企业级管理后台，覆盖登录、用户/分组管理、模型配置、记忆查看检索。

**Architecture:** 仓库 `web/` 子目录下的独立 Vite SPA，经典控制台布局（左侧菜单+顶部 Header）。axios 拦截器统一处理 JWT 与 `{code,msg,data}` 信封。后端零改动，开发期 Vite 代理 `/api` 到 :8787。

**Tech Stack:** React 18.3.1 + TypeScript + Vite 7 + Ant Design 5 + React Router 7 + Axios + Vitest 4 + React Testing Library。

## Global Constraints

- 后端零改动：不修改 `src/` 下任何后端代码。
- 所有前端代码位于 `web/` 子目录，独立 `package.json` 与构建。
- 依赖版本下限（精确 pin，已验证可在 Node 20.19.0 安装运行）：
  - react `18.3.1`、react-dom `18.3.1`
  - antd `^5.29.0`
  - vite `^7.3.0`、@vitejs/plugin-react `^5.2.0`
  - react-router-dom `^7.18.0`
  - axios `^1.18.0`
  - vitest `^4.1.9`、@testing-library/react `^16.3.0`、@testing-library/jest-dom `^6`、jsdom `^29`、@testing-library/user-event `^14`
  - typescript `^5.6`（与 react18 类型匹配；不使用 ts6 beta）
  - @types/react `^18`、@types/react-dom `^18`
- 后端响应信封：`{ code: number, msg: string, data: T }`，成功 `code === 0`。
- 后端业务错误码：`1010`=用户未分配分组、`1022`=用户名已存在、`1001/1002/1003`=登录相关。
- 代码注释与变量名用英文；提交信息只描述改动本身，无任何 Claude/AI 署名。
- 端口：后端默认 `:8787`，前端 dev server `:5173`。

---

## File Structure

```
web/
├── package.json            # 依赖与脚本
├── tsconfig.json           # TS 配置
├── tsconfig.node.json      # vite 配置用 TS
├── vite.config.ts          # 含 dev 代理 + vitest 配置
├── index.html              # 挂载点
├── .gitignore              # node_modules / dist
├── src/
│   ├── main.tsx            # 入口，挂载 App + ConfigProvider(中文)
│   ├── App.tsx             # 路由表
│   ├── setupTests.ts       # vitest + jest-dom
│   ├── types/index.ts      # User/Group/ModelConfig/Memory/Envelope 类型
│   ├── api/client.ts       # axios 实例 + 拦截器
│   ├── api/auth.ts         # login
│   ├── api/admin.ts        # users/groups
│   ├── api/modelConfig.ts  # 模型配置
│   ├── api/memory.ts       # 记忆
│   ├── store/auth.ts       # 登录态(localStorage)
│   ├── components/ProtectedRoute.tsx
│   ├── components/AppLayout.tsx     # 左菜单+顶栏
│   └── pages/
│       ├── Login.tsx
│       ├── Users.tsx
│       ├── Groups.tsx
│       ├── ModelConfig.tsx
│       └── Memory.tsx
```

---

### Task 1: 项目脚手架与可运行骨架

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/tsconfig.node.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/.gitignore`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/setupTests.ts`

**Interfaces:**
- Produces: 可 `npm install` 与 `npm run dev/build/test` 的 web 工程；`App` 组件渲染占位首页。

- [ ] **Step 1: 创建 `web/package.json`**

```json
{
  "name": "echo-admin-web",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "antd": "^5.29.0",
    "@ant-design/icons": "^5.5.0",
    "react-router-dom": "^7.18.0",
    "axios": "^1.18.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^5.2.0",
    "typescript": "^5.6.0",
    "vite": "^7.3.0",
    "vitest": "^4.1.9",
    "jsdom": "^29.0.0",
    "@testing-library/react": "^16.3.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/user-event": "^14.0.0"
  }
}
```

- [ ] **Step 2: 创建 `web/.gitignore`**

```
node_modules/
dist/
*.local
```

- [ ] **Step 3: 创建 `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 4: 创建 `web/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: 创建 `web/vite.config.ts`（含代理与 vitest 配置）**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
})
```

- [ ] **Step 6: 创建 `web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Echo Agent 管理后台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: 创建 `web/src/setupTests.ts`**

```ts
import '@testing-library/jest-dom'
```

- [ ] **Step 8: 创建 `web/src/App.tsx`（占位）**

```tsx
export default function App() {
  return <div>Echo Admin</div>
}
```

- [ ] **Step 9: 创建 `web/src/main.tsx`**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import 'antd/dist/reset.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
)
```

- [ ] **Step 10: 安装依赖并验证构建**

Run: `cd web && npm install && npm run build`
Expected: 安装成功，`tsc -b` 无类型错误，`vite build` 产出 `dist/`。

- [ ] **Step 11: Commit**

```bash
git add web/package.json web/package-lock.json web/.gitignore web/tsconfig.json web/tsconfig.node.json web/vite.config.ts web/index.html web/src/main.tsx web/src/App.tsx web/src/setupTests.ts
git commit -m "feat(web): 初始化前端工程脚手架"
```

### Task 2: 类型定义、登录态 store 与 axios 客户端

**Files:**
- Create: `web/src/types/index.ts`
- Create: `web/src/store/auth.ts`
- Create: `web/src/api/client.ts`
- Test: `web/src/store/auth.test.ts`
- Test: `web/src/api/client.test.ts`

**Interfaces:**
- Produces:
  - `types`: `Envelope<T>`, `User { id, username, role: 'admin'|'member', groupId: string|null, disabled?: boolean }`, `Group { id, name }`, `ModelConfig { baseUrl, modelName, allowLocalOverride, hasCredential }`, `Memory { id, content, tags, sourceUser?, createdAt? }`, `MemoryHit extends Memory { score?: number }`, `AuthState { token, user }`.
  - `store/auth.ts`: `saveAuth(state: AuthState): void`, `loadAuth(): AuthState | null`, `clearAuth(): void`, `getToken(): string | null`.
  - `api/client.ts`: default export `client` (AxiosInstance)；请求拦截器注入 `Authorization`；响应拦截器：`code===0` 返回 `res.data.data`，`code!==0` reject 带 `msg`，HTTP 401 调用 `clearAuth()` 并跳 `/login`。

- [ ] **Step 1: 创建 `web/src/types/index.ts`**

```ts
export interface Envelope<T> { code: number; msg: string; data: T }
export type Role = 'admin' | 'member'
export interface User { id: string; username: string; role: Role; groupId: string | null; disabled?: boolean }
export interface Group { id: string; name: string }
export interface ModelConfig {
  baseUrl: string | null
  modelName: string | null
  allowLocalOverride: boolean
  hasCredential: boolean
}
export interface Memory { id: string; content: string; tags: string[]; sourceUser?: string; createdAt?: number }
export interface MemoryHit extends Memory { score?: number }
export interface AuthState { token: string; user: User }
```

- [ ] **Step 2: 写失败测试 `web/src/store/auth.test.ts`**

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { saveAuth, loadAuth, clearAuth, getToken } from './auth'
import type { AuthState } from '../types'

const sample: AuthState = {
  token: 'tok123',
  user: { id: 'u1', username: 'admin', role: 'admin', groupId: null },
}

describe('auth store', () => {
  beforeEach(() => localStorage.clear())

  it('saves and loads auth state', () => {
    saveAuth(sample)
    expect(loadAuth()).toEqual(sample)
    expect(getToken()).toBe('tok123')
  })

  it('returns null when empty', () => {
    expect(loadAuth()).toBeNull()
    expect(getToken()).toBeNull()
  })

  it('clears auth state', () => {
    saveAuth(sample)
    clearAuth()
    expect(loadAuth()).toBeNull()
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd web && npx vitest run src/store/auth.test.ts`
Expected: FAIL（`./auth` 不存在）。

- [ ] **Step 4: 实现 `web/src/store/auth.ts`**

```ts
import type { AuthState } from '../types'

const KEY = 'echo-admin-auth'

export function saveAuth(state: AuthState): void {
  localStorage.setItem(KEY, JSON.stringify(state))
}

export function loadAuth(): AuthState | null {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthState
  } catch {
    return null
  }
}

export function clearAuth(): void {
  localStorage.removeItem(KEY)
}

export function getToken(): string | null {
  return loadAuth()?.token ?? null
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd web && npx vitest run src/store/auth.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 6: 写失败测试 `web/src/api/client.test.ts`**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import client from './client'
import { saveAuth, clearAuth } from '../store/auth'

const mock = new MockAdapter(client)

beforeEach(() => {
  mock.reset()
  clearAuth()
})

describe('api client', () => {
  it('unwraps data when code===0', async () => {
    mock.onGet('/api/ping').reply(200, { code: 0, msg: 'ok', data: { pong: true } })
    const data = await client.get('/api/ping')
    expect(data).toEqual({ pong: true })
  })

  it('rejects with msg when code!==0', async () => {
    mock.onGet('/api/ping').reply(200, { code: 1022, msg: '用户名已存在', data: null })
    await expect(client.get('/api/ping')).rejects.toThrow('用户名已存在')
  })

  it('injects Authorization header when token exists', async () => {
    saveAuth({ token: 'tok123', user: { id: 'u', username: 'a', role: 'admin', groupId: null } })
    mock.onGet('/api/ping').reply((cfg) => {
      expect(cfg.headers?.Authorization).toBe('Bearer tok123')
      return [200, { code: 0, msg: 'ok', data: 1 }]
    })
    await client.get('/api/ping')
  })

  it('clears auth on HTTP 401', async () => {
    saveAuth({ token: 'tok123', user: { id: 'u', username: 'a', role: 'admin', groupId: null } })
    mock.onGet('/api/ping').reply(401)
    await expect(client.get('/api/ping')).rejects.toBeTruthy()
    expect(localStorage.getItem('echo-admin-auth')).toBeNull()
  })
})
```

注：需在 devDependencies 加 `axios-mock-adapter ^2`。

- [ ] **Step 7: 安装 axios-mock-adapter 并运行测试确认失败**

Run: `cd web && npm install -D axios-mock-adapter@^2 && npx vitest run src/api/client.test.ts`
Expected: FAIL（`./client` 不存在）。

- [ ] **Step 8: 实现 `web/src/api/client.ts`**

```ts
import axios from 'axios'
import { message } from 'antd'
import { getToken, clearAuth } from '../store/auth'
import type { Envelope } from '../types'

const client = axios.create({ baseURL: '' })

client.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

client.interceptors.response.use(
  (response) => {
    const body = response.data as Envelope<unknown>
    if (body && typeof body.code === 'number') {
      if (body.code === 0) return body.data as never
      message.error(body.msg || '请求失败')
      return Promise.reject(new Error(body.msg || '请求失败'))
    }
    return response.data as never
  },
  (error) => {
    if (error.response?.status === 401) {
      clearAuth()
      if (location.pathname !== '/login') location.assign('/login')
    } else {
      message.error(error.message || '网络错误')
    }
    return Promise.reject(error)
  },
)

export default client
```

- [ ] **Step 9: 运行测试确认通过**

Run: `cd web && npx vitest run src/api/client.test.ts`
Expected: PASS（4 tests）。注：401 跳转测试在 jsdom 下 `location.assign` 为 noop，不影响 clearAuth 断言。

- [ ] **Step 10: Commit**

```bash
git add web/src/types web/src/store web/src/api/client.ts web/src/store/auth.test.ts web/src/api/client.test.ts web/package.json web/package-lock.json
git commit -m "feat(web): 类型定义、登录态存储与 axios 客户端"
```

### Task 3: 各模块 API 封装

**Files:**
- Create: `web/src/api/auth.ts`
- Create: `web/src/api/admin.ts`
- Create: `web/src/api/modelConfig.ts`
- Create: `web/src/api/memory.ts`
- Test: `web/src/api/admin.test.ts`

**Interfaces:**
- Consumes: `client` from `api/client.ts`；类型 from `types/index.ts`。
- Produces:
  - `auth.ts`: `login(username, password): Promise<AuthState>`
  - `admin.ts`: `listUsers(): Promise<User[]>`, `createUser(p: { username; password; role?; groupId? }): Promise<User>`, `updateUser(id, p: { groupId?; disabled? }): Promise<{ updated: boolean }>`, `listGroups(): Promise<Group[]>`, `createGroup(name): Promise<Group>`
  - `modelConfig.ts`: `getModelConfig(): Promise<ModelConfig>`, `updateModelConfig(p: { baseUrl?; modelName?; credential?; allowLocalOverride: boolean }): Promise<{ updated: boolean }>`
  - `memory.ts`: `listMemories(p?: { limit?; offset? }): Promise<Memory[]>`, `searchMemories(query, topK?): Promise<MemoryHit[]>`, `deleteMemory(id): Promise<{ deleted: boolean }>`

- [ ] **Step 1: 创建 `web/src/api/auth.ts`**

```ts
import client from './client'
import type { AuthState } from '../types'

export function login(username: string, password: string): Promise<AuthState> {
  return client.post<AuthState, AuthState>('/api/auth/login', { username, password })
}
```

注：axios 方法用两个泛型 `client.post<T, T>(...)` 让返回类型为 `Promise<T>`，与响应拦截器「返回 data」的运行时行为一致，否则默认返回 `AxiosResponse` 会触发 tsc 类型错误。后续所有 api 函数同此约定。

- [ ] **Step 2: 创建 `web/src/api/admin.ts`**

```ts
import client from './client'
import type { User, Group } from '../types'

export function listUsers(): Promise<User[]> {
  return client.get<User[], User[]>('/api/admin/users')
}
export function createUser(p: {
  username: string; password: string; role?: string; groupId?: string | null
}): Promise<User> {
  return client.post<User, User>('/api/admin/users', p)
}
export function updateUser(
  id: string,
  p: { groupId?: string | null; disabled?: boolean },
): Promise<{ updated: boolean }> {
  return client.patch<{ updated: boolean }, { updated: boolean }>(`/api/admin/users/${id}`, p)
}
export function listGroups(): Promise<Group[]> {
  return client.get<Group[], Group[]>('/api/admin/groups')
}
export function createGroup(name: string): Promise<Group> {
  return client.post<Group, Group>('/api/admin/groups', { name })
}
```

- [ ] **Step 3: 创建 `web/src/api/modelConfig.ts`**

```ts
import client from './client'
import type { ModelConfig } from '../types'

export function getModelConfig(): Promise<ModelConfig> {
  return client.get<ModelConfig, ModelConfig>('/api/model-config')
}
export function updateModelConfig(p: {
  baseUrl?: string | null
  modelName?: string | null
  credential?: string
  allowLocalOverride: boolean
}): Promise<{ updated: boolean }> {
  return client.put<{ updated: boolean }, { updated: boolean }>('/api/admin/model-config', p)
}
```

- [ ] **Step 4: 创建 `web/src/api/memory.ts`**

```ts
import client from './client'
import type { Memory, MemoryHit } from '../types'

export function listMemories(p?: { limit?: number; offset?: number }): Promise<Memory[]> {
  return client.get<Memory[], Memory[]>('/api/project-memory', { params: p })
}
export function searchMemories(query: string, topK?: number): Promise<MemoryHit[]> {
  return client.post<MemoryHit[], MemoryHit[]>('/api/project-memory/search', { query, topK })
}
export function deleteMemory(id: string): Promise<{ deleted: boolean }> {
  return client.delete<{ deleted: boolean }, { deleted: boolean }>(`/api/project-memory/${id}`)
}
```

- [ ] **Step 5: 写测试 `web/src/api/admin.test.ts`**

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import client from './client'
import { listUsers, createUser, updateUser, createGroup } from './admin'

const mock = new MockAdapter(client)
beforeEach(() => mock.reset())

describe('admin api', () => {
  it('lists users', async () => {
    mock.onGet('/api/admin/users').reply(200, { code: 0, msg: 'ok', data: [{ id: 'u1', username: 'a', role: 'admin', groupId: null }] })
    const users = await listUsers()
    expect(users).toHaveLength(1)
    expect(users[0].username).toBe('a')
  })

  it('creates a user with payload', async () => {
    mock.onPost('/api/admin/users').reply((cfg) => {
      expect(JSON.parse(cfg.data)).toMatchObject({ username: 'bob', password: 'p' })
      return [200, { code: 0, msg: 'ok', data: { id: 'u2', username: 'bob', role: 'member', groupId: null } }]
    })
    const u = await createUser({ username: 'bob', password: 'p' })
    expect(u.id).toBe('u2')
  })

  it('patches a user by id', async () => {
    mock.onPatch('/api/admin/users/u1').reply(200, { code: 0, msg: 'ok', data: { updated: true } })
    const r = await updateUser('u1', { disabled: true })
    expect(r.updated).toBe(true)
  })

  it('creates a group', async () => {
    mock.onPost('/api/admin/groups').reply(200, { code: 0, msg: 'ok', data: { id: 'g1', name: 'team' } })
    const g = await createGroup('team')
    expect(g.name).toBe('team')
  })
})
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd web && npx vitest run src/api/admin.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 7: Commit**

```bash
git add web/src/api
git commit -m "feat(web): 各模块 API 封装"
```

### Task 4: 登录页、受保护路由、布局与路由表

**Files:**
- Create: `web/src/pages/Login.tsx`
- Create: `web/src/components/ProtectedRoute.tsx`
- Create: `web/src/components/AppLayout.tsx`
- Modify: `web/src/App.tsx`（替换占位为路由表）
- Test: `web/src/pages/Login.test.tsx`
- Test: `web/src/components/ProtectedRoute.test.tsx`

**Interfaces:**
- Consumes: `login` from `api/auth.ts`；`saveAuth/loadAuth` from `store/auth.ts`。
- Produces:
  - `ProtectedRoute`: 组件，props `{ adminOnly?: boolean }`，未登录→ `/login`；`adminOnly` 且非 admin→ `/memory`；否则渲染 `<Outlet/>`。
  - `AppLayout`: 左菜单（按 role 过滤）+ 顶栏（用户名+退出）+ `<Outlet/>`。
  - `App`: 路由表 `/login`、`/`(受保护，含 users/groups/model-config/memory 子路由)。

- [ ] **Step 1: 创建 `web/src/pages/Login.tsx`**

```tsx
import { Button, Card, Form, Input, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { login } from '../api/auth'
import { saveAuth } from '../store/auth'

export default function Login() {
  const navigate = useNavigate()
  const onFinish = async (v: { username: string; password: string }) => {
    const auth = await login(v.username, v.password)
    saveAuth(auth)
    navigate('/')
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#f0f2f5' }}>
      <Card style={{ width: 380 }}>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>Echo Agent 管理后台</Typography.Title>
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>登录</Button>
        </Form>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: 创建 `web/src/components/ProtectedRoute.tsx`**

```tsx
import { Navigate, Outlet } from 'react-router-dom'
import { loadAuth } from '../store/auth'

export default function ProtectedRoute({ adminOnly }: { adminOnly?: boolean }) {
  const auth = loadAuth()
  if (!auth) return <Navigate to="/login" replace />
  if (adminOnly && auth.user.role !== 'admin') return <Navigate to="/memory" replace />
  return <Outlet />
}
```

- [ ] **Step 3: 创建 `web/src/components/AppLayout.tsx`**

```tsx
import { Layout, Menu, Dropdown, Avatar } from 'antd'
import { UserOutlined, TeamOutlined, SettingOutlined, DatabaseOutlined, LogoutOutlined } from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { loadAuth, clearAuth } from '../store/auth'

const { Header, Sider, Content } = Layout

export default function AppLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const auth = loadAuth()
  const isAdmin = auth?.user.role === 'admin'

  const items = [
    ...(isAdmin ? [
      { key: '/users', icon: <UserOutlined />, label: '用户管理' },
      { key: '/groups', icon: <TeamOutlined />, label: '分组管理' },
      { key: '/model-config', icon: <SettingOutlined />, label: '模型配置' },
    ] : []),
    { key: '/memory', icon: <DatabaseOutlined />, label: '记忆查看' },
  ]

  const logout = () => { clearAuth(); nav('/login') }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" collapsible>
        <div style={{ height: 48, margin: 16, color: '#fff', fontWeight: 600, textAlign: 'center', lineHeight: '48px' }}>Echo Admin</div>
        <Menu theme="dark" mode="inline" selectedKeys={[loc.pathname]} items={items} onClick={(e) => nav(e.key)} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 24 }}>
          <Dropdown menu={{ items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout }] }}>
            <span style={{ cursor: 'pointer' }}><Avatar size="small" icon={<UserOutlined />} /> {auth?.user.username}</span>
          </Dropdown>
        </Header>
        <Content style={{ margin: 24 }}><Outlet /></Content>
      </Layout>
    </Layout>
  )
}
```

- [ ] **Step 4: 替换 `web/src/App.tsx` 为路由表**

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import AppLayout from './components/AppLayout'
import Login from './pages/Login'
import Users from './pages/Users'
import Groups from './pages/Groups'
import ModelConfig from './pages/ModelConfig'
import Memory from './pages/Memory'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/memory" element={<Memory />} />
            <Route element={<ProtectedRoute adminOnly />}>
              <Route path="/users" element={<Users />} />
              <Route path="/groups" element={<Groups />} />
              <Route path="/model-config" element={<ModelConfig />} />
            </Route>
            <Route path="/" element={<Navigate to="/memory" replace />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
```

注：此步引用了 Task 5/6/7 的页面组件。为保证本任务可独立编译，先创建 4 个最小占位页（下一步），由后续任务替换实现。

- [ ] **Step 5: 创建 4 个占位页**

`web/src/pages/Users.tsx`、`Groups.tsx`、`ModelConfig.tsx`、`Memory.tsx`，每个内容为：

```tsx
export default function Page() {
  return <div>placeholder</div>
}
```

（文件名对应导出默认组件即可，名称随意。）

- [ ] **Step 6: 写测试 `web/src/components/ProtectedRoute.test.tsx`**

```tsx
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProtectedRoute from './ProtectedRoute'
import { saveAuth, clearAuth } from '../store/auth'

function renderAt(path: string, adminOnly?: boolean) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute adminOnly={adminOnly} />}>
          <Route path="/secret" element={<div>secret</div>} />
        </Route>
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/memory" element={<div>memory page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => clearAuth())

describe('ProtectedRoute', () => {
  it('redirects to login when not authenticated', () => {
    renderAt('/secret')
    expect(screen.getByText('login page')).toBeInTheDocument()
  })

  it('renders content when authenticated', () => {
    saveAuth({ token: 't', user: { id: 'u', username: 'a', role: 'admin', groupId: null } })
    renderAt('/secret')
    expect(screen.getByText('secret')).toBeInTheDocument()
  })

  it('redirects member to /memory on adminOnly route', () => {
    saveAuth({ token: 't', user: { id: 'u', username: 'm', role: 'member', groupId: 'g1' } })
    renderAt('/secret', true)
    expect(screen.getByText('memory page')).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: 写测试 `web/src/pages/Login.test.tsx`**

```tsx
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Login from './Login'
import * as authApi from '../api/auth'
import { loadAuth, clearAuth } from '../store/auth'

beforeEach(() => clearAuth())

describe('Login', () => {
  it('logs in and stores auth', async () => {
    vi.spyOn(authApi, 'login').mockResolvedValue({
      token: 'tok', user: { id: 'u', username: 'admin', role: 'admin', groupId: null },
    })
    render(<MemoryRouter><Login /></MemoryRouter>)
    await userEvent.type(screen.getByLabelText('用户名'), 'admin')
    await userEvent.type(screen.getByLabelText('密码'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(loadAuth()?.token).toBe('tok')
  })
})
```

- [ ] **Step 8: 运行测试与构建确认通过**

Run: `cd web && npx vitest run src/components/ProtectedRoute.test.tsx src/pages/Login.test.tsx && npm run build`
Expected: 测试 PASS（4 tests），构建无类型错误。

- [ ] **Step 9: Commit**

```bash
git add web/src
git commit -m "feat(web): 登录页、受保护路由、布局与路由表"
```

### Task 5: 用户管理与分组管理页面

**Files:**
- Modify: `web/src/pages/Users.tsx`（替换占位）
- Modify: `web/src/pages/Groups.tsx`（替换占位）
- Test: `web/src/pages/Users.test.tsx`

**Interfaces:**
- Consumes: `listUsers/createUser/updateUser/listGroups/createGroup` from `api/admin.ts`；`User/Group` types。
- Produces: 两个完整页面组件（默认导出）。

- [ ] **Step 1: 实现 `web/src/pages/Groups.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, Modal, Table, message } from 'antd'
import { listGroups, createGroup } from '../api/admin'
import type { Group } from '../types'

export default function Groups() {
  const [data, setData] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const reload = async () => {
    setLoading(true)
    try { setData(await listGroups()) } finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])

  const onCreate = async (v: { name: string }) => {
    await createGroup(v.name)
    message.success('分组已创建')
    setOpen(false); form.resetFields(); reload()
  }

  return (
    <Card title="分组管理" extra={<Button type="primary" onClick={() => setOpen(true)}>新建分组</Button>}>
      <Table rowKey="id" loading={loading} dataSource={data} columns={[
        { title: 'ID', dataIndex: 'id' },
        { title: '名称', dataIndex: 'name' },
      ]} />
      <Modal title="新建分组" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={onCreate}>
          <Form.Item label="分组名称" name="name" rules={[{ required: true, message: '请输入分组名称' }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
```

- [ ] **Step 2: 实现 `web/src/pages/Users.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, Modal, Select, Switch, Table, Tag, message } from 'antd'
import { listUsers, createUser, updateUser, listGroups } from '../api/admin'
import type { User, Group } from '../types'

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const reload = async () => {
    setLoading(true)
    try {
      const [u, g] = await Promise.all([listUsers(), listGroups()])
      setUsers(u); setGroups(g)
    } finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])

  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name ?? '-'

  const onCreate = async (v: { username: string; password: string; role: string; groupId?: string }) => {
    await createUser(v)
    message.success('用户已创建')
    setOpen(false); form.resetFields(); reload()
  }

  const toggleDisabled = async (u: User) => {
    await updateUser(u.id, { disabled: !u.disabled })
    message.success(u.disabled ? '已启用' : '已禁用')
    reload()
  }

  const changeGroup = async (u: User, groupId: string) => {
    await updateUser(u.id, { groupId })
    message.success('分组已更新')
    reload()
  }

  return (
    <Card title="用户管理" extra={<Button type="primary" onClick={() => setOpen(true)}>新建用户</Button>}>
      <Table rowKey="id" loading={loading} dataSource={users} columns={[
        { title: '用户名', dataIndex: 'username' },
        { title: '角色', dataIndex: 'role', render: (r: string) => <Tag color={r === 'admin' ? 'gold' : 'blue'}>{r}</Tag> },
        { title: '分组', dataIndex: 'groupId', render: (_: unknown, u: User) => (
          <Select size="small" style={{ minWidth: 120 }} value={u.groupId ?? undefined}
            placeholder={groupName(u.groupId)} onChange={(v) => changeGroup(u, v)}
            options={groups.map((g) => ({ value: g.id, label: g.name }))} />
        ) },
        { title: '状态', dataIndex: 'disabled', render: (d: boolean) => <Tag color={d ? 'red' : 'green'}>{d ? '禁用' : '正常'}</Tag> },
        { title: '操作', render: (_: unknown, u: User) => (
          <Switch checkedChildren="启用" unCheckedChildren="禁用" checked={!u.disabled} onChange={() => toggleDisabled(u)} />
        ) },
      ]} />
      <Modal title="新建用户" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" initialValues={{ role: 'member' }} onFinish={onCreate}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}><Input /></Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password /></Form.Item>
          <Form.Item label="角色" name="role"><Select options={[{ value: 'admin', label: 'admin' }, { value: 'member', label: 'member' }]} /></Form.Item>
          <Form.Item label="分组" name="groupId"><Select allowClear options={groups.map((g) => ({ value: g.id, label: g.name }))} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
```

- [ ] **Step 3: 写测试 `web/src/pages/Users.test.tsx`**

```tsx
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import * as adminApi from '../api/admin'
import Users from './Users'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(adminApi, 'listUsers').mockResolvedValue([
    { id: 'u1', username: 'admin', role: 'admin', groupId: null, disabled: false },
  ])
  vi.spyOn(adminApi, 'listGroups').mockResolvedValue([{ id: 'g1', name: 'team' }])
})

describe('Users page', () => {
  it('renders fetched users', async () => {
    render(<Users />)
    await waitFor(() => expect(screen.getByText('admin')).toBeInTheDocument())
  })
})
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run src/pages/Users.test.tsx`
Expected: PASS（1 test）。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Users.tsx web/src/pages/Groups.tsx web/src/pages/Users.test.tsx
git commit -m "feat(web): 用户管理与分组管理页面"
```

### Task 6: 模型配置页面

**Files:**
- Modify: `web/src/pages/ModelConfig.tsx`（替换占位）
- Test: `web/src/pages/ModelConfig.test.tsx`

**Interfaces:**
- Consumes: `getModelConfig/updateModelConfig` from `api/modelConfig.ts`；`ModelConfig` type。
- Produces: 完整页面组件（默认导出）。凭证字段：仅当用户输入新值才提交 `credential`，留空则不提交（保留后端原值）。展示 `hasCredential` 为「已配置/未配置」。

- [ ] **Step 1: 实现 `web/src/pages/ModelConfig.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, Switch, Tag, message } from 'antd'
import { getModelConfig, updateModelConfig } from '../api/modelConfig'
import type { ModelConfig } from '../types'

export default function ModelConfigPage() {
  const [cfg, setCfg] = useState<ModelConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()

  const reload = async () => {
    setLoading(true)
    try {
      const c = await getModelConfig()
      setCfg(c)
      form.setFieldsValue({ baseUrl: c.baseUrl, modelName: c.modelName, allowLocalOverride: c.allowLocalOverride, credential: '' })
    } finally { setLoading(false) }
  }
  useEffect(() => { reload() }, [])

  const onSave = async (v: { baseUrl?: string; modelName?: string; credential?: string; allowLocalOverride: boolean }) => {
    const payload: Parameters<typeof updateModelConfig>[0] = {
      baseUrl: v.baseUrl || null,
      modelName: v.modelName || null,
      allowLocalOverride: v.allowLocalOverride,
    }
    if (v.credential) payload.credential = v.credential
    await updateModelConfig(payload)
    message.success('模型配置已保存')
    reload()
  }

  return (
    <Card title="模型配置" loading={loading}>
      <Form form={form} layout="vertical" style={{ maxWidth: 520 }} onFinish={onSave}>
        <Form.Item label="Base URL" name="baseUrl"><Input placeholder="https://api.openai.com/v1" /></Form.Item>
        <Form.Item label="模型名称" name="modelName"><Input placeholder="gpt-4o-mini" /></Form.Item>
        <Form.Item label={<span>凭证 API Key {cfg && <Tag color={cfg.hasCredential ? 'green' : 'default'}>{cfg.hasCredential ? '已配置' : '未配置'}</Tag>}</span>}
          name="credential" extra="留空则不修改现有凭证">
          <Input.Password placeholder="输入以更新凭证" autoComplete="new-password" />
        </Form.Item>
        <Form.Item label="允许本地覆盖" name="allowLocalOverride" valuePropName="checked"><Switch /></Form.Item>
        <Button type="primary" htmlType="submit">保存</Button>
      </Form>
    </Card>
  )
}
```

- [ ] **Step 2: 写测试 `web/src/pages/ModelConfig.test.tsx`**

```tsx
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/modelConfig'
import ModelConfigPage from './ModelConfig'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'getModelConfig').mockResolvedValue({
    baseUrl: 'https://x', modelName: 'm', allowLocalOverride: true, hasCredential: true,
  })
})

describe('ModelConfig page', () => {
  it('shows configured tag and omits credential when left blank', async () => {
    const update = vi.spyOn(api, 'updateModelConfig').mockResolvedValue({ updated: true })
    render(<ModelConfigPage />)
    await waitFor(() => expect(screen.getByText('已配置')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update.mock.calls[0][0]).not.toHaveProperty('credential')
  })
})
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd web && npx vitest run src/pages/ModelConfig.test.tsx`
Expected: PASS（1 test）。

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/ModelConfig.tsx web/src/pages/ModelConfig.test.tsx
git commit -m "feat(web): 模型配置页面"
```

### Task 7: 记忆查看与检索页面

**Files:**
- Modify: `web/src/pages/Memory.tsx`（替换占位）
- Test: `web/src/pages/Memory.test.tsx`

**Interfaces:**
- Consumes: `listMemories/searchMemories/deleteMemory` from `api/memory.ts`；`loadAuth` from `store/auth.ts`；`Memory/MemoryHit` types。
- Produces: 完整页面组件（默认导出）。无 `groupId` 用户显示 Empty 引导而非报错；支持列表浏览、检索（带 score 列）、删除二次确认。

- [ ] **Step 1: 实现 `web/src/pages/Memory.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Button, Card, Empty, Input, Popconfirm, Space, Table, Tag, message } from 'antd'
import { listMemories, searchMemories, deleteMemory } from '../api/memory'
import { loadAuth } from '../store/auth'
import type { Memory, MemoryHit } from '../types'

export default function MemoryPage() {
  const hasGroup = !!loadAuth()?.user.groupId
  const [rows, setRows] = useState<MemoryHit[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState(false)

  const reload = async () => {
    setLoading(true)
    try { setRows(await listMemories({ limit: 50 })); setSearched(false) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (hasGroup) reload() }, [])

  const onSearch = async () => {
    if (!query.trim()) { reload(); return }
    setLoading(true)
    try { setRows(await searchMemories(query, 10)); setSearched(true) }
    finally { setLoading(false) }
  }

  const onDelete = async (id: string) => {
    await deleteMemory(id)
    message.success('已删除')
    reload()
  }

  if (!hasGroup) {
    return <Card title="记忆查看"><Empty description="当前账号未分配分组，无法查看项目记忆。请联系管理员分配分组。" /></Card>
  }

  const columns = [
    { title: '内容', dataIndex: 'content', ellipsis: true },
    { title: '标签', dataIndex: 'tags', render: (t: string[]) => (t ?? []).map((x) => <Tag key={x}>{x}</Tag>) },
    ...(searched ? [{ title: '相似度', dataIndex: 'score', width: 110, render: (s?: number) => (s == null ? '-' : s.toFixed(4)) }] : []),
    { title: '操作', width: 90, render: (_: unknown, r: Memory) => (
      <Popconfirm title="确认删除这条记忆?" onConfirm={() => onDelete(r.id)}>
        <Button danger size="small">删除</Button>
      </Popconfirm>
    ) },
  ]

  return (
    <Card title="记忆查看与检索">
      <Space style={{ marginBottom: 16 }}>
        <Input.Search style={{ width: 360 }} placeholder="输入关键词进行向量检索" value={query}
          onChange={(e) => setQuery(e.target.value)} onSearch={onSearch} enterButton="检索" />
        <Button onClick={reload}>显示全部</Button>
      </Space>
      <Table rowKey="id" loading={loading} dataSource={rows} columns={columns} />
    </Card>
  )
}
```

- [ ] **Step 2: 写测试 `web/src/pages/Memory.test.tsx`**

```tsx
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import * as memApi from '../api/memory'
import { saveAuth, clearAuth } from '../store/auth'
import MemoryPage from './Memory'

beforeEach(() => { vi.restoreAllMocks(); clearAuth() })

describe('Memory page', () => {
  it('shows guidance when user has no group', () => {
    saveAuth({ token: 't', user: { id: 'u', username: 'm', role: 'member', groupId: null } })
    render(<MemoryPage />)
    expect(screen.getByText(/未分配分组/)).toBeInTheDocument()
  })

  it('lists memories when user has group', async () => {
    saveAuth({ token: 't', user: { id: 'u', username: 'm', role: 'member', groupId: 'g1' } })
    vi.spyOn(memApi, 'listMemories').mockResolvedValue([
      { id: 'm1', content: 'hello memory', tags: ['x'] },
    ])
    render(<MemoryPage />)
    await waitFor(() => expect(screen.getByText('hello memory')).toBeInTheDocument())
  })
})
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd web && npx vitest run src/pages/Memory.test.tsx`
Expected: PASS（2 tests）。

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Memory.tsx web/src/pages/Memory.test.tsx
git commit -m "feat(web): 记忆查看与检索页面"
```

### Task 8: 全量验证与文档

**Files:**
- Modify: `web/src/pages/Users.tsx`（删除文件顶部无用 import，若有）— 仅当 `npm run build` 报 `noUnusedLocals` 时清理。
- Create: `web/README.md`
- Modify: `README.md`（根，追加前端章节）

**Interfaces:**
- Consumes: 前序所有任务产物。
- Produces: 全量测试通过 + 可构建 + 启动说明文档。

- [ ] **Step 1: 运行全量测试**

Run: `cd web && npx vitest run`
Expected: 所有测试 PASS（共 19 个：auth 3 + client 4 + admin 4 + ProtectedRoute 3 + Login 1 + Users 1 + ModelConfig 1 + Memory 2）。

- [ ] **Step 2: 全量构建**

Run: `cd web && npm run build`
Expected: `tsc -b` 无类型错误，`vite build` 成功产出 `dist/`。若报未使用变量错误，按提示清理对应 import。

- [ ] **Step 3: 创建 `web/README.md`**

```markdown
# Echo Agent 管理后台前端

React + TypeScript + Vite + Ant Design 5 的管理后台，对接 echo-agent-server。

## 开发
1. 确保后端已在 :8787 运行（仓库根目录 `./start.sh`）。
2. `cd web && npm install && npm run dev`，访问 http://localhost:5173 。
   dev server 通过代理将 `/api` 转发到 :8787。

## 构建
`npm run build` 产出 `dist/`，由任意静态服务器托管。
注意：生产环境若与后端不同源，需后端配置 CORS（当前后端未配置）。

## 测试
`npm run test`（Vitest + React Testing Library）。

## 功能
- 登录鉴权（JWT）
- 用户管理：列表、新建、改分组、启用/禁用（仅 admin）
- 分组管理：列表、新建（仅 admin）
- 模型配置：查看/修改，凭证不回显（仅 admin 可改）
- 记忆查看：列表、向量检索、删除（按分组隔离）
```

- [ ] **Step 4: 在根 `README.md` 末尾追加前端章节**

```markdown

## 管理后台前端
`web/` 目录是 React + Ant Design 管理后台。开发：`cd web && npm install && npm run dev`（需后端先在 :8787 运行）。详见 `web/README.md`。
```

- [ ] **Step 5: 手动冒烟验证（启动后端 + 前端）**

Run:
```bash
# 终端 A：仓库根
./start.sh
# 终端 B
cd web && npm run dev
```
Expected: 浏览器打开 :5173 → 登录页；用 `.env` 中的管理员账号登录 → 进入记忆页；admin 可见用户/分组/模型配置菜单。验证后 `./stop.sh` 停后端。

- [ ] **Step 6: Commit**

```bash
git add web/README.md README.md
git commit -m "docs(web): 前端启动说明与功能文档"
```

## Self-Review 检查记录

- 根 `.gitignore` 已含 `node_modules/`、`dist/`，但前端在 `web/` 下另有独立 `web/.gitignore`（Task 1 Step 2 创建），覆盖 `web/node_modules`、`web/dist`，无需改根 gitignore。
- 后端零改动约束：全部任务仅在 `web/`、`docs/`、根 `README.md` 内操作，未触碰 `src/`。✓

