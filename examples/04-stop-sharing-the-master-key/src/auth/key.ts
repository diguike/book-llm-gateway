// 内部 Key 的生成 / 哈希 / 校验
//
// 与 one-api 的对比 (common/random/main.go:23 GenerateKey):
//   - one-api 用 math/rand + UUID 拼 48 个字符. 数学上够随机, 但 math/rand
//     在并发下可能产生重复值 (它共享全局 PRNG 状态);
//   - 本书直接用 Node 的 crypto.randomBytes(32) -> base64url, 走系统 CSPRNG,
//     256 bit 熵足以排除碰撞, 字面长度 ~43 字符;
//   - 前缀 sk-gw- 取自 OpenAI 的 sk- 前缀 + gw (gateway) 命名, 客户端代码
//     看一眼就知道这是网关签发的 Key, 不会和上游 Key 混淆.
//
// 关键设计: 数据库只存 sha256 哈希, 不存明文.
//   - 明文 Key 仅在 issueKey() 返回值里出现一次;
//   - 后续从 DB 取 Key 永远只看 keyHash + keyPreview;
//   - 这意味着: 用户丢失 Key 不能找回, 只能吊销 + 重新签发. 这是规范行为.
//
// 为什么不用 bcrypt / argon2:
//   - 那两个是为「人类口令」设计的, 抗暴力破解;
//   - Key 本身有 256 bit 熵, 暴力破解的难度等同于直接猜原始 Key, 加慢哈希反而拖慢鉴权;
//   - sha256 已经远超「数据库泄露后能被还原」的安全边界. GitHub PAT / Stripe API Key
//     都是这套策略.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PREFIX = 'sk-gw-';
/** 32 字节 = 256 bit. base64url 编码后字面长度 43 字符. */
const KEY_RANDOM_BYTES = 32;

export interface GeneratedKey {
  /** 明文 Key, 仅返回给调用方一次 */
  plaintext: string;
  /** sha256 哈希, 存 DB */
  hash: string;
  /** 显示用前缀 + 末 4 位, 例: sk-gw-...x9k2. 不参与鉴权. */
  preview: string;
}

/** 生成一把新 Key (随机 + 哈希 + 预览). 调用时机: admin API / CLI 签发. */
export function generateKey(): GeneratedKey {
  const random = randomBytes(KEY_RANDOM_BYTES).toString('base64url');
  const plaintext = `${KEY_PREFIX}${random}`;
  const hash = sha256Hex(plaintext);
  const tail = plaintext.slice(-4);
  const preview = `${KEY_PREFIX}...${tail}`;
  return { plaintext, hash, preview };
}

/** 对一把明文 Key 算 sha256, 用于鉴权阶段从 Authorization header 反查 DB */
export function hashKey(plaintext: string): string {
  return sha256Hex(plaintext);
}

/** 形态校验: 一把 Key 是不是网关签发的形态 (前缀 + 长度) */
export function isWellFormedKey(plaintext: string): boolean {
  if (!plaintext.startsWith(KEY_PREFIX)) return false;
  // base64url(32 bytes) = 43 chars, 但保守允许 40-64 区间
  const tail = plaintext.slice(KEY_PREFIX.length);
  return tail.length >= 40 && tail.length <= 64 && /^[A-Za-z0-9_-]+$/.test(tail);
}

/**
 * 常量时间比对两个哈希值. 防御时序侧信道.
 * 鉴权主路径用的是「以哈希查 DB」(B-tree 索引), 不直接走这个比对;
 * 这个函数主要给 admin token 的明文比对场景用 (ADMIN_TOKEN 是低熵字符串, 必须常量时间比).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export { KEY_PREFIX };
