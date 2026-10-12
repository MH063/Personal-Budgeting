import { inflateSync } from 'fflate';

/**
 * WinZip AES（AE-1 / AE-2）条目解密。
 *
 * 背景：此前仅支持明文 zip 与 zipcrypto（PKWARE 传统加密，见 importZip.ts），
 * WinZip AES 加密包被直接判为「不支持」，用户只能回导出端改选「明文」重新导出，
 * 在真实账单迁移场景会挡住一批用户。本模块补齐 AES 解密，全程在本机离线完成、不上传任何数据。
 *
 * 规范要点（APPNOTE.TXT §4.4.7 与 WinZip AES 规范）：
 *  - 压缩方法 99；额外字段 0x9901 携带 version(AE-1=1 / AE-2=2)、vendor "AE"、strength(1/2/3)、实际压缩方法；
 *  - 条目数据区布局：盐(saltLen) + 2 字节口令校验值 + 密文 + 10 字节认证码（HMAC-SHA1 截断）；
 *  - 盐长度 = 密钥长度 / 2（AES-128→8、AES-192→12、AES-256→16）；
 *  - 密钥派生：PBKDF2-HMAC-SHA1、1000 次迭代，输出 keyLen*2+2 字节 = AES 密钥 + HMAC 密钥 + 2 字节口令校验值；
 *  - 加密：AES-CTR，计数器为 16 字节「小端」、从 1 起逐块 +1；
 *  - 认证：AE-2 对「密文」计算、AE-1 对「明文」计算，取 HMAC-SHA1 前 10 字节比对。
 *
 * 实现取舍（为什么自实现 AES/SHA1 而不用 Web Crypto）：
 *  - Web Crypto 的 AES-CTR 按「大端」递增计数器，与 WinZip 的「小端」语义不兼容；
 *    而 AES-ECB 并不在 Web Crypto 标准算法集内（Node 与浏览器均报 Unrecognized algorithm name），
 *    无法借其手工生成小端计数密钥流。
 *  - 若改用「逐 16 字节调用一次 AES-CTR」的方式，几 MB 账单就要数十万次异步调用，性能不可接受。
 *  - 故此处自实现「仅加密方向」的 AES 分组加密 + SHA-1/HMAC/PBKDF2，保持纯同步、零依赖，
 *    并由 importZip.test.ts 用 OpenSSL 生成的 AES 夹具做交叉验证（非自证自明）。
 */

/** 0x9901 额外字段解析结果 */
export interface AesExtraField {
  /** 1 = AE-1（认证码覆盖明文）、2 = AE-2（认证码覆盖密文） */
  version: number;
  /** 加密强度：1 = 128 位、2 = 192 位、3 = 256 位 */
  strength: number;
  /** 条目实际使用的压缩方法（8 = deflate、0 = store） */
  actualMethod: number;
}

/** 强度字节 → AES 密钥长度（字节）；非法强度返回 null */
export function aesKeyLenOfStrength(strength: number): number | null {
  if (strength === 1) return 16;
  if (strength === 2) return 24;
  if (strength === 3) return 32;
  return null;
}

/**
 * 从 zip 额外字段中解析 0x9901（WinZip AES）记录。
 * 记录布局（相对记录数据起点）：version(2) + vendor"AE"(2) + strength(1) + 实际压缩方法(2) = 7 字节。
 * 未找到或不完整时返回 null（调用方据此判定为不支持）。
 */
export function parseAesExtra(extra: Uint8Array): AesExtraField | null {
  if (extra.length < 4) return null;
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = view.getUint16(off, true);
    const size = view.getUint16(off + 2, true);
    // 命中 AES 记录且长度足够（7 字节数据域）
    if (id === 0x9901 && size >= 7 && off + 4 + size <= extra.length) {
      return {
        version: view.getUint16(off + 4, true),
        strength: extra[off + 8],
        actualMethod: view.getUint16(off + 9, true),
      };
    }
    off += 4 + size;
  }
  return null;
}

// ============================ SHA-1 / HMAC / PBKDF2 ============================

/** SHA-1 摘要（FIPS 180-4），返回 20 字节 */
function sha1(msg: Uint8Array): Uint8Array {
  const ml = msg.length;
  const paddedLen = Math.ceil((ml + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(msg);
  buf[ml] = 0x80;
  const view = new DataView(buf.buffer);
  // 报文长度（bit）：高 32 位 + 低 32 位，大端写入末尾 8 字节
  view.setUint32(paddedLen - 8, Math.floor(ml / 536870912), false);
  view.setUint32(paddedLen - 4, (ml * 8) >>> 0, false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((v << 1) | (v >>> 31)) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false); ov.setUint32(4, h1, false); ov.setUint32(8, h2, false);
  ov.setUint32(12, h3, false); ov.setUint32(16, h4, false);
  return out;
}

/** 拼接若干字节段 */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** HMAC-SHA1（RFC 2104） */
function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const blockSize = 64;
  const k = key.length > blockSize ? sha1(key) : key;
  const ipad = new Uint8Array(blockSize).fill(0x36);
  const opad = new Uint8Array(blockSize).fill(0x5c);
  for (let i = 0; i < k.length; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
  return sha1(concat(opad, sha1(concat(ipad, msg))));
}

/** PBKDF2-HMAC-SHA1（RFC 2898），返回 dkLen 字节派生密钥 */
function pbkdf2Sha1(password: Uint8Array, salt: Uint8Array, iterations: number, dkLen: number): Uint8Array {
  const hLen = 20;
  const blocks = Math.ceil(dkLen / hLen);
  const dk = new Uint8Array(blocks * hLen);
  const input = new Uint8Array(salt.length + 4);
  input.set(salt);
  for (let i = 1; i <= blocks; i++) {
    input[salt.length] = (i >>> 24) & 0xff;
    input[salt.length + 1] = (i >>> 16) & 0xff;
    input[salt.length + 2] = (i >>> 8) & 0xff;
    input[salt.length + 3] = i & 0xff;
    let u = hmacSha1(password, input);
    const t = u.slice();
    for (let c = 1; c < iterations; c++) {
      u = hmacSha1(password, u);
      for (let j = 0; j < hLen; j++) t[j] ^= u[j];
    }
    dk.set(t, (i - 1) * hLen);
  }
  return dk.subarray(0, dkLen);
}

// ============================ AES（仅加密方向，用于 CTR 密钥流） ============================

/** AES S 盒（FIPS 197 标准表，十六进制字符串便于核对） */
const AES_SBOX: Uint8Array = (() => {
  const hex =
    '637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0' +
    'b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275' +
    '09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf' +
    'd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2' +
    'cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb' +
    'e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08' +
    'ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e' +
    'e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16';
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = parseInt(hex.substr(i * 2, 2), 16);
  return t;
})();

/** GF(2^8) 上乘 x（即乘 2），模 AES 不可约多项式 0x11b */
const xtime = (a: number): number => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

/**
 * AES 密钥扩展，返回按轮展平的轮密钥（每轮 16 字节）与轮数。
 * key 长度须为 16 / 24 / 32 字节，轮数分别为 10 / 12 / 14。
 */
function aesExpandKey(key: Uint8Array): { roundKeys: Uint8Array; nr: number } {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    const o = i * 4;
    let t0 = w[o - 4], t1 = w[o - 3], t2 = w[o - 2], t3 = w[o - 1];
    if (i % nk === 0) {
      // RotWord + SubWord + Rcon
      const tmp = t0;
      t0 = AES_SBOX[t1] ^ rcon; t1 = AES_SBOX[t2]; t2 = AES_SBOX[t3]; t3 = AES_SBOX[tmp];
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      // AES-256 专属的额外 SubWord
      t0 = AES_SBOX[t0]; t1 = AES_SBOX[t1]; t2 = AES_SBOX[t2]; t3 = AES_SBOX[t3];
    }
    w[o] = w[o - nk * 4] ^ t0;
    w[o + 1] = w[o - nk * 4 + 1] ^ t1;
    w[o + 2] = w[o - nk * 4 + 2] ^ t2;
    w[o + 3] = w[o - nk * 4 + 3] ^ t3;
  }
  return { roundKeys: w, nr };
}

/** 轮密钥异或（轮次 r 的密钥位于 roundKeys[r*16 .. r*16+15]） */
function addRoundKey(s: Uint8Array, roundKeys: Uint8Array, round: number): void {
  const base = round * 16;
  for (let i = 0; i < 16; i++) s[i] ^= roundKeys[base + i];
}

/** SubBytes：逐字节查 S 盒 */
function subBytes(s: Uint8Array): void {
  for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
}

/** ShiftRows：state 索引 = r + 4c（r 行、c 列），第 r 行循环左移 r 字节 */
function shiftRows(s: Uint8Array): void {
  for (let r = 1; r < 4; r++) {
    const row = [s[r], s[r + 4], s[r + 8], s[r + 12]];
    for (let c = 0; c < 4; c++) s[r + 4 * c] = row[(c + r) % 4];
  }
}

/** MixColumns：每列按 GF(2^8) 与固定矩阵相乘 */
function mixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const o = 4 * c;
    const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
    s[o] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    s[o + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    s[o + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    s[o + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}

/** AES 单分组加密（输入 16 字节，输出 16 字节） */
function aesEncryptBlock(input: Uint8Array, roundKeys: Uint8Array, nr: number): Uint8Array {
  const s = input.slice();
  addRoundKey(s, roundKeys, 0);
  for (let round = 1; round < nr; round++) {
    subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, roundKeys, round);
  }
  subBytes(s); shiftRows(s); addRoundKey(s, roundKeys, nr);
  return s;
}

/** 生成 CTR 密钥流：计数器为 16 字节小端、从 1 起逐块 +1（WinZip AES 语义） */
function aesCtrKeystream(aesKey: Uint8Array, byteLength: number): Uint8Array {
  const { roundKeys, nr } = aesExpandKey(aesKey);
  const blocks = Math.ceil(byteLength / 16);
  const ks = new Uint8Array(blocks * 16);
  const counter = new Uint8Array(16);
  for (let i = 0; i < blocks; i++) {
    let v = i + 1;
    for (let b = 0; b < 16 && v > 0; b++) { counter[b] = v & 0xff; v = Math.floor(v / 256); }
    ks.set(aesEncryptBlock(counter, roundKeys, nr), i * 16);
  }
  return ks;
}

/** 逐字节异或（两段等长） */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** 解密结果：失败原因语义与 importZip 的 ExtractResult 对齐（由调用方转译） */
export type AesDecryptResult =
  | { ok: true; plain: Uint8Array }
  | { ok: false; reason: 'bad_password' | 'unsupported' | 'corrupt' };

/**
 * 解密单个 WinZip AES 条目并返回解压后的明文。
 *
 * @param entryData 该条目的完整数据区（盐 + 2 字节校验值 + 密文 + 10 字节认证码）
 * @param password  用户输入的压缩包口令
 * @param extra     该条目的 0x9901 额外字段解析结果
 */
export function decryptWinZipAes(
  entryData: Uint8Array,
  password: string,
  extra: AesExtraField
): AesDecryptResult {
  const keyLen = aesKeyLenOfStrength(extra.strength);
  if (keyLen === null) return { ok: false, reason: 'unsupported' };
  const saltLen = keyLen / 2;
  if (entryData.length < saltLen + 2 + 10) return { ok: false, reason: 'corrupt' };

  const salt = entryData.subarray(0, saltLen);
  const verifier = entryData.subarray(saltLen, saltLen + 2);
  const cipher = entryData.subarray(saltLen + 2, entryData.length - 10);
  const authCode = entryData.subarray(entryData.length - 10);

  // PBKDF2-HMAC-SHA1（1000 次）派生：AES 密钥 + HMAC 密钥 + 2 字节口令校验值
  const derived = pbkdf2Sha1(new TextEncoder().encode(password), salt, 1000, keyLen * 2 + 2);
  const aesKey = derived.subarray(0, keyLen);
  const macKey = derived.subarray(keyLen, keyLen * 2);

  // 口令校验值先行比对：密码错误可快速失败，无需进入解密流程
  if (derived[keyLen * 2] !== verifier[0] || derived[keyLen * 2 + 1] !== verifier[1]) {
    return { ok: false, reason: 'bad_password' };
  }

  const plain = xorBytes(cipher, aesCtrKeystream(aesKey, cipher.length));

  // 认证码校验：AE-2 覆盖密文、AE-1 覆盖明文；不通过按「密码错误」处理（与真实工具行为一致）
  const macTarget = extra.version >= 2 ? cipher : plain;
  const mac = hmacSha1(macKey, macTarget);
  for (let i = 0; i < authCode.length; i++) {
    if (mac[i] !== authCode[i]) return { ok: false, reason: 'bad_password' };
  }

  // 解压：8 = deflate、0 = store，其余方法不支持
  if (extra.actualMethod === 8) {
    try {
      return { ok: true, plain: inflateSync(plain) };
    } catch {
      return { ok: false, reason: 'bad_password' };
    }
  }
  if (extra.actualMethod === 0) return { ok: true, plain };
  return { ok: false, reason: 'unsupported' };
}
