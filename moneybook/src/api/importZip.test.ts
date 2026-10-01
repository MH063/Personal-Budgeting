/**
 * 加密账单本地解密（importZip）单元测试。
 * 覆盖：zip 魔数识别、无密码 zip 解压、目录条目过滤、文本乱码占比判定（应对"错误密码解出乱码"）。
 * 说明：fflate 自建 zip 的密码选项在 v0.8 下不强制抛错，故不就此断言错误密码；真实微信账单为 zipcrypto，
 *       错误密码路径由"解压抛错 → null"与"解出乱码 → null"双保险兜底（后者由本文件的乱码用例覆盖）。
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strFromU8, strToU8 } from 'fflate';
import { isZip, extractFromZipWithPassword, detectZipEncryption, zipIsXlsxStructure } from './importZip';

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