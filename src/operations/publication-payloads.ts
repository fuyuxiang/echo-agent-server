import { z } from 'zod'
export const MemoryPayload = z.object({
  kind: z.enum(['fact', 'decision', 'convention', 'pitfall', 'howto']),
  content: z.string().min(1).max(2000),
  rationale: z.string().max(2000).optional(),
  evidence: z
    .array(
      z.object({
        type: z.enum(['doc', 'qa', 'meeting', 'task']),
        id: z.string().min(1).max(256),
        loc: z.string().max(1000).optional()
      })
    )
    .max(20)
    .optional(),
  confidence: z.coerce.number().min(0).max(1).default(0.7),
  observedAt: z.coerce.number().int().optional(),
  validFrom: z.coerce.number().int().optional(),
  validUntil: z.coerce.number().int().optional(),
  supersedesId: z.string().max(256).optional(),
  sourceSessionId: z.string().max(256).optional(),
  sourceTaskId: z.string().max(256).optional(),
  workspaceRef: z.string().max(1000).optional(),
  outcome: z.string().max(2000).optional(),
  sensitivity: z.coerce.number().int().min(0).max(3).default(0)
})

export const DocumentPayload = z.object({
  title: z.string().min(1).max(500),
  // 会议纪要、问答结论这类文本直接内联,不走文件上传。
  text: z.string().min(1),
  sourceType: z.enum(['meeting', 'qa', 'md', 'txt']).default('meeting'),
  volatility: z.enum(['stable', 'volatile']).optional()
})
