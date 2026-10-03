-- 010: 疑似重复记账判定持久化（用户要求：人工复核结果不因刷新丢失，可自行判定）
--
-- 背景：疑似重复记账此前只有本地启发式 + 可选 AI 判定，判定结果仅存于页面内存，
-- 刷新/重进后回到初始状态；且没有「用户人工判定」入口。本迁移新增 dup_reviews 表，
-- 持久化每一对待核对配对的判定结果（pair_key = 两笔交易 id 升序拼接）：
--   - source='user'：用户手动判定（确认重复 / 标记正常 / 待核查），优先级最高；
--   - source='ai'：AI 判定缓存（刷新不丢，用户可随时推翻）；
-- 已判定的配对不再出现在「疑似重复」待处理列表，可在「已处理」中展开回顾。

CREATE TABLE IF NOT EXISTS dup_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_key TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('dup','ok','uncertain')),
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','ai')),
  ledger_id INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (pair_key, source, ledger_id)
);
CREATE INDEX IF NOT EXISTS idx_dup_reviews_ledger ON dup_reviews(ledger_id);
