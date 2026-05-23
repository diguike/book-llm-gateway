// 倍率体系
//
// final_cost = base_cost
//            × (user_multiplier   / 1000)   // 用户折扣 / 加价 (来自 users.userMultiplier)
//            × (channel_multiplier / 1000)  // 渠道加价 (Ch8 渠道池接入后会替换硬编码)
//            × (model_multiplier   / 1000)  // 模型倍率 (来自 prices.modelMultiplier)
//
// 为什么用「倍率」而不是「直接改价格」:
//   - 价格表是上游事实价 (运营按官方价目维护), 不该被业务策略污染;
//   - 倍率层把「定价策略」(用户分组折扣 / 渠道分销加价 / 模型粒度调节) 与
//     「成本核算」隔离, 调单价时不影响策略, 调策略时不动单价;
//   - 同一个客户在不同渠道下能拿到不同的实际价, 用倍率组合天然就能表达 (channel_multiplier
//     在 Ch8 渠道池里挂在 Channel 上).
//
// 千分位 integer 存储:
//   - 倍率范围 0.001x ~ 10x, 千分位精度对教学场景够用 (实际生产可以扩到万分位);
//   - 整数乘法不掉精度. 三个倍率相乘后是九位 integer, 再除以 1_000_000_000 = 1.0x.
//
// 与 one-api 的对比:
//   - one-api 的 modelRatio 与 groupRatio 直接是 float64, 写在 Go map 里编译进二进制
//     (relay/billing/ratio/model.go:13), 改价要重启;
//   - one-api 的「分组倍率」(groupRatio) 等价于本书的 userMultiplier;
//   - one-api 没有显式的 channelMultiplier, 是通过 Channel 直接挂不同 Model 的方式间接表达;
//   - 本书 v0.5 用 integer 千分位 + DB 存储, 同时拆出 channel × model × user 三个维度,
//     与 new-api 的方向一致, 只是没引入表达式计费 (留到 Ch10).

import { eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { getCurrentPrice } from '../billing/prices.js';

const MULTIPLIER_SCALE = 1000;

export interface MultiplierContext {
  userId: number;
  model: string;
  provider: string;
}

export interface CombinedMultiplier {
  /** 用户倍率 (千分位 integer) */
  user: number;
  /** 渠道倍率 (千分位 integer). v0.5 默认 1000, Ch8 渠道池接入后会从 channels 表读 */
  channel: number;
  /** 模型倍率 (千分位 integer) */
  model: number;
  /** 三者乘积 (1e9 = 1.0x). 直接落账到 usage_records.multiplier_snapshot */
  combinedScale1e9: number;
  /** 用于乘到 cost 上的实数倍率 (= combinedScale1e9 / 1e9) */
  combinedFloat: number;
}

/**
 * 组合三个维度的倍率.
 *
 * v0.5 实现:
 *   - user: 查 users.userMultiplier;
 *   - channel: 暂时硬编码 1.0x (Ch8 接入 channels 表后从 channels.weight 读);
 *   - model: 查 prices.modelMultiplier.
 */
export function resolveMultiplier(ctx: MultiplierContext): CombinedMultiplier {
  const db = getDb();
  const userRows = db
    .select({ m: users.userMultiplier })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .all();
  const userMul = userRows.length > 0 ? userRows[0]!.m : MULTIPLIER_SCALE;

  const price = getCurrentPrice(ctx.model, ctx.provider);
  const modelMul = price.modelMultiplier;

  // v0.5: 渠道倍率写死 1.0x. Ch8 替换为按 channel 查询.
  const channelMul = MULTIPLIER_SCALE;

  const combined = userMul * channelMul * modelMul;
  return {
    user: userMul,
    channel: channelMul,
    model: modelMul,
    combinedScale1e9: combined,
    combinedFloat: combined / (MULTIPLIER_SCALE * MULTIPLIER_SCALE * MULTIPLIER_SCALE),
  };
}

export { MULTIPLIER_SCALE };
