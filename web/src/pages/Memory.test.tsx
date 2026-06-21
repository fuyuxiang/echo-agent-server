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
