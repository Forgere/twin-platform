import {
  calculateRigState,
  createHttpJevClient,
  jevConfigFromEnv,
  toFishingState,
  toJevRequest,
} from '@twin-platform/plugins-fishing';

/**
 * Jev 联通性冒烟：一次最小请求，验证 key / baseUrl / 模型 / 响应解码。
 *
 * 从 apps/server 目录跑（Bun 会自动加载 `.env`）：
 *   bun run smoke:jev
 *
 * 未配置 key 时明确跳过，不报错。脚本不会打印 key。
 */

const config = jevConfigFromEnv(process.env);
if (!config) {
  console.log('[jev-smoke] JEV_API_KEY 未配置，跳过。');
  process.exit(0);
}

const rig = calculateRigState({ t0: 4, t: 2, w: 1, d: 1 });
if (!rig.ok) throw new Error('测试钓组不合法');

const request = toJevRequest(toFishingState(rig.state, { intent: 'bite_no_catch' }));
const client = createHttpJevClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });

console.log('[jev-smoke] baseUrl=' + config.baseUrl + ' model=' + config.model + ' language=' + config.language);
const started = Date.now();
try {
  const decision = await client.decide(request);
  console.log('[jev-smoke] OK ' + (Date.now() - started) + 'ms ' + JSON.stringify(decision));
} catch (error) {
  console.error('[jev-smoke] 失败：' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
