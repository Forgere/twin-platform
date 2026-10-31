/**
 * 单场景部署：把「一份 scene.json + 它需要的插件集」发布成纯静态站点。
 *
 * 平台部署要服务端 + 数据库 + token；给人看**一个**场景不需要这些。这条命令把
 * 场景文件拷进 Studio 的 `public/`（Vite 构建时原样进 `dist/client`），再用
 * `VITE_SCENE_URL` / `VITE_SCENE_PLUGINS` 构建，Worker 只发静态资产、不配 UPSTREAM。
 *
 * 用法：
 *   bun run deploy:scene                                   # 默认物流中心示例
 *   bun run deploy:scene -- examples/packages/logistics-center/scene.json
 *   bun run deploy:scene -- <scene.json> --plugin logistics
 *   bun run deploy:scene -- <scene.json> --plugin fishing --out .scene-ci/site
 *
 * 不自动 `wrangler deploy`：发布是显式动作，且不同人 Worker 名不同。构建完会打印
 * 发布命令（默认 `apps/worker`，`--out` 自定义目录时打印 `wrangler pages deploy`）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSceneDocument } from '@twin-platform/scene-schema';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = resolve(repoRoot, 'apps/studio/public');
const SCENE_ASSET = 'scene.json';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
let scenePath = 'examples/packages/logistics-center/scene.json';
let plugin = 'logistics';
let outDir = '';
let skipBuild = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--plugin') plugin = args[++i] ?? plugin;
  else if (arg === '--out') outDir = args[++i] ?? '';
  else if (arg === '--no-build') skipBuild = true;
  else if (arg && !arg.startsWith('--')) scenePath = arg;
}

// 1. 场景先过一遍解析 + 迁移 + 校验：发布出去的必须和 Studio 导入走同一道门。
const source = resolve(repoRoot, scenePath);
const text = await Bun.file(source).text();
const parsed = parseSceneDocument(text);
if (!parsed.ok || !parsed.scene) {
  console.error('场景校验未通过，未发布：');
  for (const issue of parsed.issues) console.error(`  ${issue.path} ${issue.message}`);
  process.exit(1);
}
if (parsed.applied.length > 0) {
  console.log(`已迁移旧版本场景：${parsed.applied.join('、')}`);
}

// 2. 放进 public/：构建期 Vite 把它当静态资产原样拷贝，路径固定为 /scene.json。
mkdirSync(PUBLIC_DIR, { recursive: true });
writeFileSync(resolve(PUBLIC_DIR, SCENE_ASSET), `${JSON.stringify(parsed.scene, null, 2)}\n`, 'utf-8');
console.log(`场景 ${parsed.scene.id}（${parsed.scene.entities.length} 实体）→ public/${SCENE_ASSET}，插件 ${plugin}`);

// 3. 构建：两个 VITE_* 是单场景模式的唯一开关（见 apps/studio/src/scene/staticScene.ts）。
if (skipBuild && outDir) {
  console.error('--out 需要构建产物，不能和 --no-build 一起用。');
  process.exit(1);
}
if (!skipBuild) {
  const result = Bun.spawnSync({
    cmd: ['bun', 'run', '--filter', '@twin-platform/studio', 'build'],
    cwd: repoRoot,
    env: { ...process.env, VITE_SCENE_URL: `/${SCENE_ASSET}`, VITE_SCENE_PLUGINS: plugin },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
  // 场景已进 dist/client；public/ 里那份是构建用的临时件，留着会让下一次普通
  // `bun run build` 把它当静态资产一起拷进去（多场景产物里冒出个单场景文件）。
  rmSync(resolve(PUBLIC_DIR, SCENE_ASSET), { force: true });
}

// 4. 自定义输出目录：把 dist/client 整份搬过去，方便直接 `wrangler pages deploy`。
const dist = resolve(repoRoot, 'apps/studio/dist/client');
if (outDir) {
  const target = resolve(repoRoot, outDir);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const result = Bun.spawnSync({ cmd: ['cp', '-R', `${dist}/.`, target], cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
  console.log(`静态站点已就绪：${outDir}`);
  console.log(`发布：bun x wrangler pages deploy ${outDir} --project-name twin-scene`);
} else if (skipBuild) {
  console.log(`未构建（--no-build）：public/${SCENE_ASSET} 已就位。`);
  console.log('本地看：VITE_SCENE_URL=/scene.json VITE_SCENE_PLUGINS=' + plugin + ' bun run dev');
} else {
  console.log('静态站点已就绪：apps/studio/dist/client（含 /scene.json）');
  console.log('发布：cd apps/worker && bun x wrangler deploy --env scene   # 静态专用 Worker，无需 UPSTREAM / API_TOKEN');
}
