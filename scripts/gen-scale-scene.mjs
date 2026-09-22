/**
 * 生成规模化场景：把物流中心模板复制到网格格点上，产出约 1000 实体的场景文件。
 *
 * 与 `scripts/bench-scale.ts` 的复制逻辑一致（id 加前缀 + 引用同步改写），但这里是
 * 把结果**落盘成可加载的场景文件**，而非仅内存压测。复制后的 N 份彼此独立、各自跑通，
 * 适合在 studio / server 里直接加载做"1000 实例"的可视化与性能测试。
 *
 * 用法：
 *   node scripts/gen-scale-scene.mjs                       # 默认 23 份 → 1035 实体
 *   SCALE_COPIES=10 node scripts/gen-scale-scene.mjs       # 10 份 → 450 实体
 *   bun scripts/gen-scale-scene.mjs                        # bun 亦可
 *
 * 环境变量：
 *   SCALE_COPIES   复制份数（默认 23，45 实体/份 → 1035）
 *   SCALE_SPACING  网格格点间距（米，默认 400，远大于单中心尺寸避免重叠）
 *   SCALE_OUT      输出路径（默认 scenes/logistics-scale-1000.twin.json）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const copies = Math.max(1, Number(process.env.SCALE_COPIES ?? 23));
const spacing = Number(process.env.SCALE_SPACING ?? 400);
const inputPath = resolve(repoRoot, 'scenes', 'logistics-center-v1.twin.json');
const outPath = resolve(repoRoot, process.env.SCALE_OUT ?? 'scenes/logistics-scale-1000.twin.json');

const base = JSON.parse(readFileSync(inputPath, 'utf8'));
if (!Array.isArray(base.entities)) throw new Error(`模板场景缺少 entities 数组：${inputPath}`);

/** 深度遍历，把"恰好等于某个实体 id"的字符串加上前缀（保持内部引用一致）。 */
function rewriteIds(value, ids, prefix) {
  if (typeof value === 'string') return ids.has(value) ? prefix + value : value;
  if (Array.isArray(value)) return value.map((item) => rewriteIds(item, ids, prefix));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = rewriteIds(item, ids, prefix);
    return out;
  }
  return value;
}

const ids = new Set(base.entities.map((entity) => entity.id));
const cols = Math.max(1, Math.ceil(Math.sqrt(copies)));
const entities = [];

for (let copy = 0; copy < copies; copy += 1) {
  const prefix = `c${copy}_`;
  const dx = (copy % cols) * spacing;
  const dz = Math.floor(copy / cols) * spacing;
  for (const entity of base.entities) {
    const clone = structuredClone(entity);
    clone.id = prefix + entity.id;
    const [px, py, pz] = clone.transform.position;
    clone.transform = { ...clone.transform, position: [px + dx, py, pz + dz] };
    if (clone.config !== undefined) clone.config = rewriteIds(clone.config, ids, prefix);
    if (clone.attrs !== undefined) clone.attrs = rewriteIds(clone.attrs, ids, prefix);
    if (clone.dataBindings !== undefined) clone.dataBindings = rewriteIds(clone.dataBindings, ids, prefix);
    entities.push(clone);
  }
}

// 落盘前校验：实体 id 必须唯一（场景契约硬规则）。
const seen = new Set();
for (const entity of entities) {
  if (seen.has(entity.id)) throw new Error(`生成的场景存在重复实体 id：${entity.id}`);
  seen.add(entity.id);
}

const scene = {
  version: base.version,
  id: 'logistics-scale-1000',
  name: `规模化物流中心（${entities.length} 实体）`,
  metadata: { generatedFrom: base.id, copies, spacing },
  entities,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(scene, null, 2) + '\n', 'utf8');
console.log(
  `已生成 ${entities.length} 实体场景 → ${outPath}\n` +
    `  （${copies} 份 × ${base.entities.length} 实体，网格 ${cols}×${Math.ceil(copies / cols)}，格点间距 ${spacing}m，占地面积约 ${((cols - 1) * spacing)}×${Math.floor((copies - 1) / cols) * spacing}m）`,
);
