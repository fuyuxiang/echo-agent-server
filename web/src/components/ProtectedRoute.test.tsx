import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProtectedRoute from './ProtectedRoute'
import { saveAuth, clearAuth } from '../store/auth'
import type { AuthState, Role } from '../types'

// 守卫只负责导航体验(不让用户点进必然 403 的页面)。真正的鉴权在服务端,
// 绕过它拿不到任何数据 —— 所以这里测的是"看到什么",不是"能否越权"。

function authAs(role: Role): AuthState {
  return {
    accessToken: 'a',
    refreshToken: 'r',
    user: {
      id: 'u1',
      username: 'someone',
      displayName: '某人',
      role,
      clearance: 0,
      groups: [],
      scopes: [],
    },
  }
}

function renderAt(
  path: string,
  guard: { adminOnly?: boolean; reviewerOnly?: boolean } = {},
): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute {...guard} />}>
          <Route path="/secret" element={<div>secret</div>} />
        </Route>
        <Route path="/login" element={<div>login page</div>} />
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

  it('renders content for an authenticated user', () => {
    saveAuth(authAs('admin'))
    renderAt('/secret')
    expect(screen.getByText('secret')).toBeInTheDocument()
  })

  it('blocks a member from an admin-only route', () => {
    saveAuth(authAs('member'))
    renderAt('/secret', { adminOnly: true })
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
    expect(screen.getByText('没有权限')).toBeInTheDocument()
  })

  it('blocks a curator from an admin-only route', () => {
    saveAuth(authAs('curator'))
    renderAt('/secret', { adminOnly: true })
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  // curator 的存在意义就是能审核而不能碰用户和模型配置。
  it('allows a curator on a reviewer route', () => {
    saveAuth(authAs('curator'))
    renderAt('/secret', { reviewerOnly: true })
    expect(screen.getByText('secret')).toBeInTheDocument()
  })

  it('allows an admin on a reviewer route', () => {
    saveAuth(authAs('admin'))
    renderAt('/secret', { reviewerOnly: true })
    expect(screen.getByText('secret')).toBeInTheDocument()
  })

  it('blocks a member from a reviewer route with guidance', () => {
    saveAuth(authAs('member'))
    renderAt('/secret', { reviewerOnly: true })
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
    // 普通成员该去用客户端,不是后台 —— 提示要说清楚去哪。
    expect(screen.getByText(/桌面客户端/)).toBeInTheDocument()
  })
})
