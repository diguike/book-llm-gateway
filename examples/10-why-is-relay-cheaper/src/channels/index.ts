// 渠道池 + 故障转移 子系统的 barrel 出口.
//
// 模块拆分:
//   - classifier.ts       : 错误分类 (transparent / retryable / disable / throttle)
//   - registry.ts         : 内存索引 ChannelRegistry, group2model2channels 三层 Map
//   - weighted-picker.ts  : 加权轮询选 channel (priority 分层 + 同层 weight 随机)
//   - router.ts           : 高层包装 - 按 (group, model) 选 channel + 构造 adaptor
//   - store.ts            : channels + abilities 双表 CRUD, 原子操作
//   - health-checker.ts   : 后台 worker, 定期扫 disabled 探活恢复

export { classifyError, THROTTLE_COOLDOWN_MS, DISABLE_PROBE_INTERVAL_MS } from './classifier.js';
export type { ErrorClass, ClassifyResult, ClassifyInput } from './classifier.js';

export {
  getChannelRegistry,
  invalidateChannelRegistry,
  ChannelRegistry,
} from './registry.js';
export type { ChannelEntry } from './registry.js';

export { pickChannel } from './weighted-picker.js';

export { pickChannelForModel, buildAdaptorForChannel } from './router.js';
export type { PickedChannel } from './router.js';

export {
  createChannel,
  updateChannel,
  deleteChannel,
  markChannelDisabled,
  markChannelActive,
  listDisabledChannels,
} from './store.js';
export type { CreateChannelInput } from './store.js';

export { startHealthChecker, stopHealthChecker, runOnce as runHealthCheckOnce } from './health-checker.js';
