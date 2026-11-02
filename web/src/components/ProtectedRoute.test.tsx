import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProtectedRoute from './ProtectedRoute'
import { saveAuth, clearAuth, loadAuth } from '../store/auth'
import { me } from '../api'
import type { AuthState, Role } from '../types'
vi.mock('../api', () => ({ me: vi.fn() }))
function authAs(role: Role): AuthState {
  return { accessToken: 'a', refreshToken: '', user: { id: 'u1', username: 'someone', displayName: '某人', role, clearance: 0, groups: [], scopes: [] } }
}
function renderPage() {
  return render(<MemoryRouter initialEntries={['/secret']}><Routes>
    <Route element={<ProtectedRoute />}><Route path="/secret" element={<div>administration content</div>} /></Route>
    <Route path="/login" element={<div>login page</div>} />
  </Routes></MemoryRouter>)
}
beforeEach(() => { vi.resetAllMocks(); clearAuth() })
describe('administrator-only console', () => {
  it('redirects an anonymous visitor to login without loading data', () => {
    renderPage()
    expect(screen.getByText('login page')).toBeInTheDocument()
    expect(me).not.toHaveBeenCalled()
  })
  it.each(['member', 'curator'] as Role[])('blocks a stored %s session on every administration page', role => {
    saveAuth(authAs(role)); renderPage()
    expect(screen.queryByText('administration content')).not.toBeInTheDocument()
    expect(screen.getByText('仅管理员可访问')).toBeInTheDocument()
    expect(me).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /返回登录/ }))
    expect(screen.getByText('login page')).toBeInTheDocument()
    expect(loadAuth()).toBeNull()
  })
  it('waits for server verification before showing administration content', async () => {
    saveAuth(authAs('admin'))
    let finish!: (user: AuthState['user']) => void
    vi.mocked(me).mockReturnValue(new Promise(resolve => { finish = resolve }))
    renderPage()
    expect(screen.queryByText('administration content')).not.toBeInTheDocument()
    finish(authAs('admin').user)
    expect(await screen.findByText('administration content')).toBeInTheDocument()
  })
  it('does not trust an administrator role forged or cached in local storage', async () => {
    saveAuth(authAs('admin'))
    vi.mocked(me).mockRejectedValue({ response: { status: 403 } })
    renderPage()
    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(loadAuth()).toBeNull()
    expect(screen.queryByText('administration content')).not.toBeInTheDocument()
  })
  it('rejects an identity response that no longer has administrator access', async () => {
    saveAuth(authAs('admin')); vi.mocked(me).mockResolvedValue(authAs('member').user)
    renderPage()
    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(loadAuth()).toBeNull()
  })
  it('allows retry after a network failure while keeping the session', async () => {
    saveAuth(authAs('admin'))
    vi.mocked(me).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(authAs('admin').user)
    renderPage()
    expect(await screen.findByText('无法验证管理员身份')).toBeInTheDocument()
    expect(loadAuth()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(await screen.findByText('administration content')).toBeInTheDocument()
    await waitFor(() => expect(me).toHaveBeenCalledTimes(2))
  })
})
