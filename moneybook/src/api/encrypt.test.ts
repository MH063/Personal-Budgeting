/**
 * AES-256-GCM 加解密工具单元测试。
 * 覆盖：密文格式、加解密往返、盐场每次不同（随机 IV）、掩码函数边界。
 */
import { describe, it, expect } from 'vitest';
import { encryptText, decryptText, maskKey } from '@/api/encrypt';

describe('encryptText / decryptText', () => {
  it('往返加解密可还原明文', async () => {
    const plain = 'sk-test-123456-abcdef';
    const enc = await encryptText(plain);
    expect(await decryptText(enc)).toBe(plain);
  });

  it('密文符合「ivBase64.cipherBase64」格式', async () => {
    const enc = await encryptText('hello');
    const parts = enc.split('.');
    expect(parts.length).toBe(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it('同一明文两次加密密文不同（随机 IV）', async () => {
    const enc1 = await encryptText('same');
    const enc2 = await encryptText('same');
    expect(enc1).not.toBe(enc2);
    expect(await decryptText(enc1)).toBe('same');
    expect(await decryptText(enc2)).toBe('same');
  });

  it('密文格式错误时解密抛错', async () => {
    await expect(decryptText('not-a-valid-enc')).rejects.toThrow();
  });
});

describe('maskKey：显示用掩码', () => {
  it('正常 Key：前 3 + *** + 后 4', () => {
    expect(maskKey('sk-test-12345678')).toBe('sk-***5678');
  });

  it('空串返回 ***', () => {
    expect(maskKey('')).toBe('***');
  });

  it('过短 Key（<=7 位）返回 ***', () => {
    expect(maskKey('abc1234')).toBe('***');
  });
});