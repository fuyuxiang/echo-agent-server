import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import * as adminApi from '../api/admin'
import Users from './Users'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(adminApi, 'listUsers').mockResolvedValue([
    { id: 'u1', username: 'alice', role: 'admin', groupId: null, disabled: false },
  ])
  vi.spyOn(adminApi, 'listGroups').mockResolvedValue([{ id: 'g1', name: 'team' }])
})

describe('Users page', () => {
  it('renders fetched users', async () => {
    render(<Users />)
    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument())
  })
})
