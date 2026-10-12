/**
 * 加密账单本地解密（importZip）单元测试。
 * 覆盖：zip 魔数识别、无密码 zip 解压、目录条目过滤、文本乱码占比判定（应对"错误密码解出乱码"）。
 * 说明：fflate 自建 zip 的密码选项在 v0.8 下不强制抛错，故不就此断言错误密码；真实微信账单为 zipcrypto，
 *       错误密码路径由"解压抛错 → null"与"解出乱码 → null"双保险兜底（后者由本文件的乱码用例覆盖）。
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strFromU8, strToU8 } from 'fflate';
import { pbkdf2Sync, createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { isZip, extractFromZipWithPassword, detectZipEncryption, zipIsXlsxStructure, tryExtractZipAsync } from './importZip';

/** 构造一个仅含本地文件头、可设定"加密位 + AES extra 字段"的字节（用于检测逻辑，不构成可解压 zip） */
function makeHeaderBuf(opts: { encryptBit?: boolean; aesExtra?: boolean; method?: number }): Uint8Array {
  const buf = new Uint8Array(30 + 3 + 7 + 2); // sig.. + filename(3) + extra(9: id2+size2+7data)
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x04034b50, true);       // 本地文件头 sig
  view.setUint16(4, 20, true);               // version
  view.setUint16(6, (opts.encryptBit ? 1 : 0), true); // flags（真实偏移为 6）
  view.setUint16(8, opts.method ?? 0, true); // 压缩方法（真实偏移为 8）
  view.setUint16(26, 3, true);               // 文件名长
  view.setUint16(28, opts.aesExtra ? 9 : 0, true); // extra len
  buf[30] = 0x61; buf[31] = 0x2e; buf[32] = 0x74; // "a.t"
  if (opts.aesExtra) {
    view.setUint16(33, 0x9901, true); // extra id = AES
    view.setUint16(35, 7, true);
  }
  return buf;
}

describe('detectZipEncryption：识别加密与 AES', () => {
  it('普通明文 zip：不加密、非 AES', () => {
    expect(detectZipEncryption(zipSync({ 'a.csv': strToU8('x') }))).toEqual({ encrypted: false, aes: false });
  });
  it('置位加密位：标记为加密但不标记 AES（属普通 zip 密码）', () => {
    expect(detectZipEncryption(makeHeaderBuf({ encryptBit: true }))?.encrypted).toBe(true);
    expect(detectZipEncryption(makeHeaderBuf({ encryptBit: true }))?.aes).toBe(false);
  });
  it('extra 含 0x9901：标记为 AES', () => {
    expect(detectZipEncryption(makeHeaderBuf({ aesExtra: true, encryptBit: true }))?.aes).toBe(true);
  });
  it('压缩方法 99 也视为 AES；非 zip 返回 null', () => {
    expect(detectZipEncryption(makeHeaderBuf({ method: 99 }))?.aes).toBe(true);
    expect(detectZipEncryption(strToU8('hello'))).toBeNull();
  });
});

/** 构造一个包含单个文本文件的 zip 二进制（可选附加密码参数）。fflate 需 strToU8 转字节，勿传原生字符串。 */
function makeZip(filename: string, content: string | Uint8Array, password?: string): Uint8Array {
  const data = typeof content === 'string' ? strToU8(content) : content;
  return zipSync({ [filename]: data }, (password ? { password } : undefined) as Parameters<typeof zipSync>[1]);
}

describe('isZip：魔数识别', () => {
  it('识别 fflate 生成的 zip 包；对普通文本/短二进制返回 false', () => {
    const zip = makeZip('a.csv', 'x');
    expect(isZip(zip)).toBe(true);
    expect(isZip(strToU8('交易时间,收支金额'))).toBe(false);
    expect(isZip(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('extractFromZipWithPassword：解压', () => {
  it('无密码 zip 可解出首个文件内容与文件名', () => {
    const zip = makeZip('bill.csv', '交易时间,金额\n2026-09-01,35.5');
    const ex = extractFromZipWithPassword(zip, '');
    expect(ex).not.toBeNull();
    expect(ex!.name).toBe('bill.csv');
    expect(strFromU8(ex!.data)).toContain('35.5');
  });

  it('带路径的条目：跳过目录，只返回文件', () => {
    const zip = makeZip('folder/bill.csv', 'a,b\n1,2');
    const ex = extractFromZipWithPassword(zip, '');
    expect(ex).not.toBeNull();
    expect(ex!.name.endsWith('/')).toBe(false);
    expect(ex!.name.endsWith('bill.csv')).toBe(true);
  });

  it('文本条目为乱码（替换符占比高）时判定为密码错误，返回 null', () => {
    // 构造一个内部 CSV 为非法 UTF-8 乱码的 zip，验证 textPlausibilityRatio 拦截
    const junk = new Uint8Array(512).fill(0xff);
    const zip = makeZip('bill.csv', junk);
    expect(extractFromZipWithPassword(zip, 'wrong-pass')).toBeNull();
  });

  it('正常文本内容不受乱码校验误伤（保留 valid CSV）', () => {
    const zip = makeZip('bill.csv', '交易时间,金额\n2026-09-01,35.5');
    expect(extractFromZipWithPassword(zip, 'any')).not.toBeNull();
  });

  it('微信明文 xlsx（zip 内套 xlsx 结构）：识别为 xlsx 结构并返回可读的完整 .xlsx', () => {
    // 微信明文 xlsx 在文件层就是 zip，内部是完整 xlsx 结构（[Content_Types].xml + xl/…）
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8('<?xml?><Types/>'),
      '_rels/.rels': strToU8('<r/>'),
      'xl/workbook.xml': strToU8('<wb/>'),
      'xl/worksheets/sheet1.xml': strToU8('<sheet/>'),
    };
    const zip = zipSync(files);
    expect(zipIsXlsxStructure(files)).toBe(true);
    expect(zipIsXlsxStructure({ 'bill.csv': strToU8('a') })).toBe(false);

    const ex = extractFromZipWithPassword(zip, '');
    expect(ex).not.toBeNull();
    expect(ex!.name.endsWith('.xlsx')).toBe(true);   // 返回的是完整 xlsx，而非单个元数据条目
    // 重打包后的 data 是完整 zip 字节，可直接被 SheetJS 读取（长度 > 单个元数据条目）
    expect(ex!.data.length).toBeGreaterThan(zipSync(files).length * 0.9);
  });
});

/**
 * 用 Node 原生 crypto（OpenSSL 实现）构造一个真实的 WinZip AES 加密 zip。
 * 关键点：AES-CTR 计数块按 WinZip 规范「以 16 字节小端、从 1 起逐块 +1」，
 * 因此这里不能用 openssl 的常规 aes-ctr（大端计数），而是用 AES-ECB 自行生成密钥流。
 * 目的：用完全独立的实现生成夹具，交叉验证 zipAes.ts 的自实现，而非自证自明。
 */
function buildAesZip(name: string, content: string, password: string, strength: 1 | 2 | 3 = 3): Uint8Array {
  const keyLen = strength === 1 ? 16 : strength === 2 ? 24 : 32;
  const salt = randomBytes(keyLen / 2);
  const derived = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, keyLen * 2 + 2, 'sha1');
  const aesKey = derived.subarray(0, keyLen);
  const macKey = derived.subarray(keyLen, keyLen * 2);
  const verifier = derived.subarray(keyLen * 2, keyLen * 2 + 2);

  const raw = Buffer.from(content, 'utf8');
  const compressed = deflateRawSync(raw);
  // AES-CTR：16 字节小端计数器，从 1 开始
  const blocks = Math.ceil(compressed.length / 16);
  const counters = Buffer.alloc(blocks * 16);
  for (let i = 0; i < blocks; i++) counters.writeUIntLE(i + 1, i * 16, 6);
  const ecb = createCipheriv(`aes-${keyLen * 8}-ecb`, aesKey, null);
  ecb.setAutoPadding(false);
  const keystream = Buffer.concat([ecb.update(counters), ecb.final()]);
  const cipherText = Buffer.alloc(compressed.length);
  for (let i = 0; i < compressed.length; i++) cipherText[i] = compressed[i] ^ keystream[i];
  // AE-2：认证码覆盖密文，取 HMAC-SHA1 前 10 字节
  const authCode = createHmac('sha1', macKey).update(cipherText).digest().subarray(0, 10);

  const entryData = Buffer.concat([salt, verifier, cipherText, authCode]);
  const nameBuf = Buffer.from(name, 'utf8');
  // 0x9901：version(2) + "AE"(2) + strength(1) + 实际压缩方法(2)
  const extra = Buffer.alloc(11);
  extra.writeUInt16LE(0x9901, 0);
  extra.writeUInt16LE(7, 2);
  extra.writeUInt16LE(2, 4);
  extra.write('AE', 6, 'ascii');
  extra[8] = strength;
  extra.writeUInt16LE(8, 9);

  const local = Buffer.alloc(30 + nameBuf.length + extra.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(51, 4);
  local.writeUInt16LE(0x0001, 6); // 加密位
  local.writeUInt16LE(99, 8); // 方法 99 = WinZip AES
  local.writeUInt32LE(entryData.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(extra.length, 28);
  nameBuf.copy(local, 30);
  extra.copy(local, 30 + nameBuf.length);

  const cd = Buffer.alloc(46 + nameBuf.length + extra.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(51, 4);
  cd.writeUInt16LE(51, 6);
  cd.writeUInt16LE(0x0001, 8);
  cd.writeUInt16LE(99, 10);
  cd.writeUInt32LE(entryData.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(extra.length, 30);
  cd.writeUInt32LE(0, 42); // 本地头偏移
  nameBuf.copy(cd, 46);
  extra.copy(cd, 46 + nameBuf.length);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(local.length + entryData.length, 16);

  return new Uint8Array(Buffer.concat([local, entryData, cd, eocd]));
}

describe('WinZip AES 解密（tryExtractZipAsync）', () => {
  it('AES-256（AE-2）：正确密码解出明文，错误密码判定为 bad_password', async () => {
    const zip = buildAesZip('bill.csv', '交易时间,金额\n2026-09-01,35.5', 'p@ss1234');
    expect(detectZipEncryption(zip)?.aes).toBe(true);

    const ok = await tryExtractZipAsync(zip, 'p@ss1234');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.name).toBe('bill.csv');
      expect(strFromU8(ok.data)).toContain('35.5');
    }

    const bad = await tryExtractZipAsync(zip, 'wrong-pass');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('bad_password');
  });

  it('AES-128（strength=1）：盐长度与密钥长度随强度变化后仍可解', async () => {
    const zip = buildAesZip('a.csv', 'a,b\n1,2', 'pw', 1);
    const r = await tryExtractZipAsync(zip, 'pw');
    expect(r.ok).toBe(true);
    if (r.ok) expect(strFromU8(r.data)).toContain('1,2');
  });

  it('非 AES 的明文 zip：异步入口委托同步实现，结果一致', async () => {
    const zip = makeZip('bill.csv', 'a,b\n1,2');
    const r = await tryExtractZipAsync(zip, '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(strFromU8(r.data)).toContain('1,2');
  });
});