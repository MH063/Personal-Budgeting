-- 添加摊销月数（amortize_months），默认0表示不摊销
ALTER TABLE transactions ADD COLUMN amortize_months INTEGER NOT NULL DEFAULT 0;
