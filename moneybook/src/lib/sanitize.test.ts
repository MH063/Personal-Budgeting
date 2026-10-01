/**
 * 数据脱敏（sanitize）单元测试。
 * 覆盖：手机/身份证/银行卡/邮箱/微信号等 PII 被掩码；订单号语境长编号被保护不被误伤；
 * sanitizeForClassification（AI 上云前）能对含隐私的备注/收款方文本做脱敏。
 */
import { describe, it, expect } from 'vitest';
import { maskSensitive, sanitizeForClassification, sanitizeRow } from './sanitize';

describe('maskSensitive：PII 掩码', () => {
  it('手机号保留前3后4', () => {
    expect(maskSensitive('联系我 13812345678')).toContain('138****5678');
  });
  it('身份证保留前4后4', () => {
    expect(maskSensitive('证件 11010519900307123X')).toMatch(/1101\*{10}123X/);
  });
  it('银行卡 13~19 位被掩码，而订单号语境编号被保护', () => {
    expect(maskSensitive('卡号 6222021234567890123')).not.toContain('6222021234567890');
    // 订单号语境：保留完整编号，避免被银行卡规则误伤
    expect(maskSensitive('订单号 20260901202345678901234567')).toContain('20260901202345678901234567');
  });
  it('邮箱/微信号被掩码', () => {
    expect(maskSensitive('邮箱abc@test.com 微信号wxid_abc12345')).not.toContain('abc@test.com');
    expect(maskSensitive('wxid_abc12345')).toContain('wxid_****');
  });
});

describe('sanitizeForClassification：AI 上云前的统一脱敏', () => {
  it('备注含手机号与邮箱时被掩码', () => {
    const out = sanitizeForClassification('便利店 收货13800138000 邮箱a@b.com');
    expect(out).not.toContain('13800138000');
    expect(out).not.toContain('a@b.com');
  });
  it('普通商户/备注文本不被误伤', () => {
    const out = sanitizeForClassification('星巴克(上海) 午饭');
    expect(out).toContain('星巴克(上海) 午饭');
  });
  it('空/未定义返回空串', () => {
    expect(sanitizeForClassification('')).toBe('');
    expect(sanitizeForClassification(undefined)).toBe('');
  });
});

describe('sanitizeRow：明细行脱敏', () => {
  it('只保留 MM-DD + 分类 + 金额 + 脱敏备注，不含完整日期与原文备注', () => {
    const line = sanitizeRow({ date: '2026-09-27', amount: 50, note: '午饭 电话13800138000', categoryName: '餐饮' });
    expect(line).toContain('09-27'); // 仅 MM-DD
    expect(line).not.toContain('2026'); // 不暴露年份
    expect(line).not.toContain('13800138000'); // 备注已脱敏
    expect(line).toContain('餐饮');

  });
});