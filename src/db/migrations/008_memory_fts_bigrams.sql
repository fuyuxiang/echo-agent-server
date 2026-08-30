-- 007 的早期构建曾将组织记忆原文直接交给 unicode61；中文连续文本
-- 无法被 bigram 查询稳定命中。重建索引，并让所有后续写入统一调用
-- openDb 注册的确定性归一化函数。

DROP TRIGGER IF EXISTS org_memories_fts_insert;
DROP TRIGGER IF EXISTS org_memories_fts_delete;
DROP TRIGGER IF EXISTS org_memories_fts_update;

DELETE FROM org_memories_fts;
INSERT INTO org_memories_fts(memory_id, content, kind)
SELECT id, echo_index_text(content), kind FROM org_memories;

CREATE TRIGGER org_memories_fts_insert AFTER INSERT ON org_memories BEGIN
  INSERT INTO org_memories_fts(memory_id, content, kind)
  VALUES (new.id, echo_index_text(new.content), new.kind);
END;
CREATE TRIGGER org_memories_fts_delete AFTER DELETE ON org_memories BEGIN
  DELETE FROM org_memories_fts WHERE memory_id = old.id;
END;
CREATE TRIGGER org_memories_fts_update AFTER UPDATE OF content, kind ON org_memories BEGIN
  DELETE FROM org_memories_fts WHERE memory_id = old.id;
  INSERT INTO org_memories_fts(memory_id, content, kind)
  VALUES (new.id, echo_index_text(new.content), new.kind);
END;
