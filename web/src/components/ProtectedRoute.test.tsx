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
