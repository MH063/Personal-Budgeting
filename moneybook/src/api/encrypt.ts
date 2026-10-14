/**
 * AES-256-GCM 加密工具：API Key 等敏感字段加密后才存入数据库 settings 表。
 * 加密密钥由【设备指纹】稳定派生，而非随机会话密钥：
 *   - 相同设备派生密钥稳定，因此 settings 表中已加密的 Key 可跨重启解密；
 *   - 设备指纹种子（持久 token）同样存 settings 表，不再使用 localStorage。
 * 密文格式：base64(iv) + '.' + base64(ciphertext)。
 *
 * 机密性边界：
 *   - 密钥不落盘（仅每次运行时现算并缓存于内存），设备指纹作为派生种子也非明文可解码的密钥；
 *   - 真正防泄漏靠「指纹并不容易从密文反推」与「设备由用户持有」。
 *
 * 说明：本系统仅运行于本机桌面（Tauri），不使用任何 localStorage / sessionStorage，
 *       旧版浏览器端的「会话密钥」兼容迁移逻辑已随方案B一并移除。
 *
 * 风险说明（设备指纹不可迁移）：
 *   - 加密密钥由本机指纹（持久 token + 屏幕/UA 特征）派生，与设备绑定；
 *   - 换机、重装、清库或设备指纹变化后，旧密文将**无法解密**（表现为读取 Key 失败）；
 *   - 因此 DB 备份迁移时必须连 settings 表中的设备 token 一并迁移，否则密文不可用。
 */
import { getKV, setKV, hydrateKV } from './kv';
import { DEVICE_TOKEN_KEY } from '@/lib/constants';

let cachedKey: CryptoKey | null = null;

function b64Encode(buf: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64Decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 稳定获取（必要时生成并持久化）设备指纹 token，使指纹跨会话稳定。
 * 安全要求：设备指纹直接决定派生密钥，禁止降级为 Math.random 这类可预测弱随机
 * （历史缺陷：旧实现以弱随机兜底，等于给密文强度开后门）。缺失 Web Crypto 时明确报错。
 */
function getDeviceToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.randomUUID) throw new Error('当前环境不支持 Web Crypto，无法生成加密所需的设备指纹');
  const exist = getKV(DEVICE_TOKEN_KEY);
  if (exist) return exist;
  const id = c.randomUUID();
  setKV(DEVICE_TOKEN_KEY, id);
  return id;
}

/** 拼接设备指纹（多特征 + 持久 token），同一设备稳定 */
function fingerprintMaterial(): string {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const scr = (globalThis as { screen?: Screen }).screen;
  return [
    nav?.userAgent ?? '',
    nav?.language ?? '',
    scr?.width ?? '',
    scr?.height ?? '',
    getDeviceToken(),
  ].join('|');
}

async function subtle(): Promise<SubtleCrypto> {
  const w = (globalThis as unknown as { crypto?: Crypto })?.crypto;
  if (!w?.subtle) throw new Error('当前环境不支持 Web Crypto');
  return w.subtle;
}

/** 由设备指纹派生 AES-256 密钥（SHA-256 → 32 字节 raw key），并在内存缓存 */
async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  // 必须先载入已保存的设备 token，避免指纹在首启未载入时重新派生导致旧密文不可解
  await hydrateKV();
  const s = await subtle();
  const digest = await s.digest('SHA-256', new TextEncoder().encode(fingerprintMaterial()));
  const keyBytes = new Uint8Array(digest);
  cachedKey = await s.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  );
  return cachedKey;
}

/** 用指定密钥解密，失败抛错 */
async function decryptWith(key: CryptoKey, enc: string): Promise<string> {
  const [ivB64, ctB64] = enc.split('.');
  if (!ivB64 || !ctB64) throw new Error('密文格式错误');
  const s = await subtle();
  const buf = await s.decrypt({ name: 'AES-GCM', iv: b64Decode(ivB64) }, key, b64Decode(ctB64));
  return new TextDecoder().decode(buf);
}

/** 加密明文，返回「ivBase64.cipherBase64」 */
export async function encryptText(plain: string): Promise<string> {
  const key = await getKey();
  const s = await subtle();
  // IV 必须来自安全随机源；此处显式判空，替换原先的 `crypto!` 非空断言，
  // 避免在不支持 Web Crypto 的环境下抛出难定位的运行时错误。
  const wc = (globalThis as { crypto?: Crypto }).crypto;
  if (!wc?.getRandomValues) throw new Error('当前环境不支持 Web Crypto，无法生成加密 IV');
  const iv = wc.getRandomValues(new Uint8Array(12));
  const padded = new TextEncoder().encode(plain);
  const ct = await s.encrypt({ name: 'AES-GCM', iv }, key, padded);
  return `${b64Encode(iv)}.${b64Encode(new Uint8Array(ct))}`;
}

/** 解密「ivBase64.cipherBase64」到明文（使用设备指纹派生密钥） */
export async function decryptText(enc: string): Promise<string> {
  return decryptWith(await getKey(), enc);
}

/** 显示用掩码：前 3 + '***' + 后 4；过短则返回 '***' */
export function maskKey(key: string): string {
  if (!key) return '***';
  if (key.length <= 7) return '***';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}