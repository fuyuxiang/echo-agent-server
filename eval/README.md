# Eval — 黄金评估集与门禁

组织记忆平台首期 / 第 8 章的离线质量门禁。运行 `npm run eval` 会：

1. 读取 `eval/dataset.jsonl`；
2. 通过 HTTP 调 `/api/v1/retrieve`（模拟真实用户身份）；
3. 计算各项指标并按阈值阻断：
   - Context Recall ≥ 0.85
   - Context Precision ≥ 0.70
   - Faithfulness ≥ 0.80（需要 ECHOx_JUDGE_* 或回退为基于引用的近似）
   - Answer Relevance ≥ 0.85（同上）
   - 权限零泄露（`must_not_leak` 文档出现次数必须 = 0，一票否决）
   - 无答案正确率 ≥ 0.90
   - 检索 p95 ≤ 800ms

输出：

- 控制台汇总表格
- `eval/reports/<date>.json` 详细结果

## 数据集 schema

每行一个 JSON：

```json
{
  "id": "q001",
  "kind": "fact | multi_hop | exact_term | no_answer | permission",
  "question": "差旅住宿标准是多少",
  "expected_doc_ids": ["d_travel_v3"],
  "expected_answer_points": ["一线城市500", "其他城市350"],
  "as_user": "u_member_1",
  "must_not_leak": ["d_board_secret"]
}
```

字段说明：

- `kind`：题型（决定如何评分）。
- `expected_doc_ids`：期望出现在 top-8 中的文档 id（Recall 指标）。
- `expected_answer_points`：期望答案中的关键点（Faithfulness/Relevance 评测用）。
- `as_user`：模拟登录的用户名（权限用例必需）。
- `must_not_leak`：这条题的答案里绝对不能出现的文档 id（权限指标）。

## 题目组成（首期 50 条）

| 类型 | 条数 | 用途 |
|---|---|---|
| fact | 20 | 召回与基础问答准确度 |
| multi_hop | 10 | 多跳聚合能力 |
| exact_term | 10 | 验证 BM25 精确词（型号/缩写/工号） |
| no_answer | 5 | 库中确实没有，期望说"不知道" |
| permission | 5 | A 用户能查到，B 用户必须查不到 |

每条都要：

1. 在测试库里有真实可召回的文档（除非 `kind=no_answer`）；
2. 用真实账号做权限测试，避免用 admin 走通所有场景。

## 评分细则

- **Recall@k（k=8）**：`expected_doc_ids` 至少有一条出现在 top-8 → 1，否则 0。
- **Precision@k（k=8）**：top-8 中相关 chunk 数 / 8。"相关" 通过 `expected_doc_ids` 反查 chunk 所属文档判定。
- **Faithfulness**：用 LLM-as-judge 让模型判断"答案论断是否被引用材料支持"。无 judge 模型时回退到基于引用的近似：所有 answer points 都能在 chunk text 中找到匹配片段，记 1。
- **Answer Relevance**：用 LLM-as-judge 判断答案是否切题；同样有 fallback。
- **No-answer 正确率**：`kind=no_answer` 且返回 chunks 为空 + `answered=false` → 1。
- **权限零泄露**：任一 `must_not_leak` 出现在任何 chunk/doc 引用 → 整体记 0，阻断。
- **p95 延迟**：全部 retrieve 请求延迟的 95 分位数 ≤ 800ms。

## 启动

```bash
# 1. 启动一个带真实数据的 server(或使用 eval/fixture.sh 自建 fixture)
npm run build
ECHO_JWT_SECRET=$(openssl rand -hex 32) \
ECHO_MASTER_KEY=$(openssl rand -hex 32) \
ECHO_ADMIN_USER=admin ECHO_ADMIN_PASSWORD=admin-pw-12345 \
node dist/server.js &

# 2. 等 server ready 后跑 eval
npm run eval

# 3. CI 一键化
npm run eval:ci
```

`npm run eval` 失败会以非零状态退出，CI 会阻断合并。
