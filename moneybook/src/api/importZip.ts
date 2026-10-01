import { unzipSync, zipSync, inflateSync, type UnzipOptions } from 'fflate';

/**
 * 加密账单本地解密模块。
 * 微信等平台导出的"加密账单"本质是带解压密码的 zip 包，可凭借用户提供的密码在本机解出内部文件，
 * 全程离线、不上传任何数据。
 *
 * ## 解密引擎选择
 *  - 明文 zip：用 fflate 的 unzipSync（成熟稳定）。
 *  - zipcrypto 加密（微信/支付宝账单最常用）：**自实现标准 PKWARE 传统加密算法**。
 *    fflate 对带 data descriptor（flags bit3）的真实银行账单 zip 的 zipcrypto 支持有缺陷——
 *    它不校验 12 字节加密头、也不按中央目录定位真实数据偏移，导致"密码正确却解出乱码/报 invalid distance"。
 *    自实现按规范处理：12 字节头校验 + CRC 高位定密 + 中央目录定位，密码正确即能稳定解开。
 *  - WinZip AES：加密方式非 zipcrypto，本机无法解，前端仅识别并引导明文导出。
 *
 * 特别说明（微信 xlsx 账单的两种形态）：
 *  - 明文 xlsx 在文件层面其实就是 zip；加密账单往往是「加密 xlsx」（zip 内套完整的 xlsx 结构）。
 *  - 因此解压出的内部并不一定是一个独立文件，而可能整套 xlsx 结构（含 [Content_Types].xml 等）。
 *    zipIsXlsxStructure 用于识别该情形，此时应返回重打包后的完整 xlsx，而非单个条目。
 */

/** 判断解出的 zip 条目集合是否为一套 Excel xlsx 结构（含 [Content_Types].xml 且含 xl/worksheets/xl/）。 */
export function zipIsXlsxStructure(files: Record<string, Uint8Array>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(files, '[Content_Types].xml') &&
    Object.keys(files).some((n) => n.startsWith('xl/'))
  );
}

/** 把解出的 xlsx 结构条目重新打包为一个完整 .xlsx（zip），供 SheetJS 直接读取。fflate 无额外依赖。 */
export function repackXlsxEntries(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 0 });
}

/** 判断二进制是否为 zip 包（魔数 PK\x03\x04，兼容空目录的空 zip 以 PK\x05\x06 起始） */
export function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
    ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06));
}

/**
 * 解析 zip 首个本地文件头，识别是否加密、是否为 WinZip AES（AES-128/192/256）。
 * 返回 null 表示不是 zip 或头部不完整；否则给出 { encrypted, aes }。
 * 用于在真正解压前区分「普通 zip 密码（zipcrypto，可本机解）」与「AES 加密（暂不支持，需引导明文导出）」。
 */
export function detectZipEncryption(buf: Uint8Array): { encrypted: boolean; aes: boolean } | null {
  if (!isZip(buf) || buf.length < 30 || buf[2] !== 0x03) return null; // 仅解析普通 zip（PK\x03\x04）
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const fnLen = view.getUint16(26, true);
  const extLen = view.getUint16(28, true);
  const encrypted = (flags & 1) === 1;
  let aes = method === 99; // 压缩方法 99 = WinZip AES
  let off = 30 + fnLen;
  const extraEnd = Math.min(off + extLen, buf.length);
  while (off + 4 <= extraEnd) {
    if (view.getUint16(off, true) === 0x9901) { aes = true; break; }
    off += 4 + view.getUint16(off + 2, true);
  }
  return { encrypted, aes };
}

/** 解出的字节是否为"文本性质"：解码为 UTF-8 后统计替换符 U+FFFD 占比。 */
function textPlausibilityRatio(data: Uint8Array): number | null {
  const sample = data.subarray(0, Math.min(data.length, 64 * 1024));
  const s = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  let bad = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\uFFFD') bad++;
  return s.length === 0 ? null : bad / s.length;
}

/**
 * 解压结果：成功返回内容；失败返回 null（无法区分具体原因时）。
 */
export type ExtractResult =
  | { ok: true; name: string; data: Uint8Array }
  | { ok: false; reason: 'aes' | 'bad_password' | 'unsupported' | 'corrupt' };

/** 兼容旧签名：成功返回内容；失败返回 null。 */
export function extractFromZipWithPassword(buf: Uint8Array, password: string): { name: string; data: Uint8Array } | null {
  const r = tryExtractZip(buf, password);
  return r.ok ? { name: r.name, data: r.data } : null;
}

// ================= PKWARE 传统加密（zipcrypto）标准实现 =================
// 依据 APPNOTE.TXT（经 adm-zip 的 methods/zipcrypto.js 验证）：
//   - 3 个 32-bit key 演化：key0=crc32step(key0,byte)；key1=(key1 + (key0&0xff))*134775813 + 1（线性同余）；
//     key2=crc32step(key2, key1>>24)。
//   - 密文前 12 字节为随机 salt 加密头；解密 salt 后，用第 12 字节做密码校验：
//     flags bit3(data descriptor) 时校验 salt[11]==header.timeHighByte，否则 salt[11]==crc>>>24。
//   - 关键坑：fflate 实现了错误的 key1 演化（不做 *134775813），故解不开真实银行账单 zip。
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
const crcStep = (crc: number, b: number) => (crcTable()[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
const uMul = (a: number, b: number) => Math.imul(a, b) >>> 0;

/** zipcrypto key 状态 */
class ZipKeys {
  keys = new Uint32Array([0x12345678, 0x23456789, 0x34567890]);
  constructor(password: string) {
    const bytes = new TextEncoder().encode(password);
    for (let i = 0; i < bytes.length; i++) this.updateKeys(bytes[i]);
  }
  updateKeys(byte: number): number {
    const k = this.keys;
    k[0] = crcStep(k[0], byte);
    k[1] += k[0] & 0xff;
    k[1] = uMul(k[1] >>> 0, 134775813) + 1;
    k[2] = crcStep(k[2], k[1] >>> 24);
    return byte;
  }
  next(): number {
    const k = (this.keys[2] | 2) >>> 0;
    return (uMul(k >>> 0, (k ^ 1) >>> 0) >> 8) & 0xff;
  }
}

/** 用密码解密一段密文（含 12 字节 salt 头），返回解密后的字节。 */
function zipDecrypt(cipher: Uint8Array, password: string): Uint8Array {
  const keys = new ZipKeys(password);
  const out = new Uint8Array(cipher.length);
  for (let i = 0; i < cipher.length; i++) {
    out[i] = keys.updateKeys(cipher[i] ^ keys.next()) & 0xff;
  }
  return out;
}

/** 中央目录条目信息 */
interface CentralEntry { name: string; method: number; offset: number; compSize: number; encrypted: boolean; flags: number; crc: number; timeHighByte: number }

/** 从 zip 二进制解析中央目录，返回所有条目。找不到返回空数组。 */
function readCentralDirectory(buf: Uint8Array): CentralEntry[] {
  // 从尾部找 EOCD 签名 PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint16(eocd + 10, true);
  const cdStart = view.getUint32(eocd + 16, true);
  const entries: CentralEntry[] = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (buf[p] !== 0x50 || buf[p + 1] !== 0x4b || buf[p + 2] !== 0x01 || buf[p + 3] !== 0x02) break; // 非中央目录条目则中断
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const time = view.getUint16(p + 12, true); // MS-DOS time（低5位秒/高2位…）用于 data descriptor 校验
    const date = view.getUint16(p + 14, true);
    const crc = view.getUint32(p + 16, true);
    // MS-DOS time 高字节（bit 4-7），zipcrypto 校验用
    const timeHighByte = (time >> 8) & 0xff;
    const nameRaw = buf.subarray(p + 46, p + 46 + nameLen);
    // 文件名编码：若设 UTF-8 flag(bit11) 用 UTF-8，否则用 GBK（中文账单文件名常为 GBK）
    let name: string;
    const utf8Flag = (flags & 0x800) !== 0;
    if (utf8Flag) name = new TextDecoder('utf-8').decode(nameRaw);
    else {
      try { name = new TextDecoder('gbk').decode(nameRaw); } catch { name = new TextDecoder('utf-8').decode(nameRaw); }
    }
    entries.push({ name, method, offset, compSize, encrypted: (flags & 1) === 1, flags, crc, timeHighByte });
    p += 46 + nameLen + extLen + commentLen;
  }
  return entries;
}

/**
 * 用密码解压 zip，返回应交给 SheetJS 的内容（带精确失败原因）：
 *  - 若内部是**完整 xlsx 结构**，返回重打包的完整 .xlsx。
 *  - 否则返回第一个非目录内部条目。
 * 密码错误/损坏返回 { ok:false, reason }。
 */
export function tryExtractZip(buf: Uint8Array, password: string): ExtractResult {
  const entries = readCentralDirectory(buf);
  const first = entries.find((e) => !e.name.endsWith('/'));
  if (!first) return { ok: false, reason: 'corrupt' };
  // 未加密 zip：交给 fflate 解出全部条目（成熟稳定）
  if (!first.encrypted) {
    try {
      const files = unzipSync(buf, (password ? { password } : undefined) as unknown as UnzipOptions);
      if (zipIsXlsxStructure(files)) return { ok: true, name: '解压后的账单.xlsx', data: repackXlsxEntries(files) };
      const en = Object.entries(files).find(([n]) => !n.endsWith('/'));
      if (!en) return { ok: false, reason: 'corrupt' };
      // 文本乱码校验（兜底，错误的密码解出乱码）
      if (/\.(csv|txt)$/i.test(en[0]) && textPlausibilityRatio(en[1]) != null && (textPlausibilityRatio(en[1]) as number) > 0.2) {
        return { ok: false, reason: 'bad_password' };
      }
      return { ok: true, name: en[0], data: en[1] };
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
  }
  // —— zipcrypto 加密：自实现标准解密 ——
  // 定位本地文件头，读取真实数据偏移（本地头 compSize 在 data descriptor 下为 0，故用中央目录的 offset+头长）
  if (buf[first.offset] !== 0x50 || buf[first.offset + 1] !== 0x4b || buf[first.offset + 2] !== 0x03 || buf[first.offset + 3] !== 0x04) {
    return { ok: false, reason: 'corrupt' };
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const localComp = view.getUint32(first.offset + 18, true); // 本地头压缩大小
  const localFnLen = view.getUint16(first.offset + 26, true);
  const localExtLen = view.getUint16(first.offset + 28, true);
  const dataStart = first.offset + 30 + localFnLen + localExtLen;
  const dataEnd = dataStart + (localComp || first.compSize); // data descriptor 下用中央目录 compSize
  if (dataEnd > buf.length || dataStart >= buf.length) return { ok: false, reason: 'corrupt' };
  const encryptedData = buf.subarray(dataStart, dataEnd);
  if (encryptedData.length < 12) return { ok: false, reason: 'corrupt' };

  // 解密整段（含 12 字节 salt 头）
  const plain = zipDecrypt(encryptedData, password);
  // 密码校验：flags bit3(data descriptor) 时校验 salt[11]==header.timeHighByte，否则==crc>>>24
  const verifyByte = (first.flags & 0x8) === 0x8 ? first.timeHighByte : (first.crc >>> 24) & 0xff;
  if (plain[11] !== verifyByte) return { ok: false, reason: 'bad_password' };

  // 去掉 12 字节加密头后的压缩流
  let payload = plain.subarray(12);
  // method 8=deflate，0=store
  if (first.method === 8) {
    try { payload = inflateSync(payload); } catch { return { ok: false, reason: 'bad_password' }; }
  } else if (first.method === 0) {
    // store：无需解压
  } else {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true, name: first.name, data: payload };
}