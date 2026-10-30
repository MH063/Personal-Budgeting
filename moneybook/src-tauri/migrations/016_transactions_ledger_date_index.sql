-- 016: 交易表补「账本 + 日期」复合索引（多账本下统计/流水列表提速）
--
-- 背景：001 已建 date / type / account_id / category_id / (date,type) 索引，
-- 但所有列表与统计查询都以 `ledger_id = ?` 作为第一过滤条件（listTransactions、
-- listTransactionsDetailed、月度收支、预算对比、对账候选等），
-- 缺少以 ledger_id 为前导列的索引时，SQLite 只能先按日期扫描再逐行回表判断账本归属，
-- 多账本或历史数据较多时开销明显。
--
-- 说明：迁移文件一旦发布不可修改；后续如需调整请新增 017+。
-- 纯新增索引、不改数据，幂等（IF NOT EXISTS），对既有库与新建库均安全。

CREATE INDEX IF NOT EXISTS idx_tx_ledger_date ON transactions(ledger_id, date);
