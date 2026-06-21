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
    await userEvent.click(screen.getByRole('button', { name: /登\s*录/ }))
    expect(loadAuth()?.token).toBe('tok')
  })
})
