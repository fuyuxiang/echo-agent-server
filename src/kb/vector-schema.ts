/**
 * sqlite-vec 表的物理维度。修改它不是普通的热配置：需要新建向量表、
 * 用新模型全量重建索引，然后原子切换。当前 schema 在 001_init.sql 中固定
 * 为 FLOAT[1024]，所以运行时必须严格保持一致。
 */
export const VECTOR_INDEX_DIM = 1024
