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
    await userEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update.mock.calls[0][0]).not.toHaveProperty('credential')
  })
})
