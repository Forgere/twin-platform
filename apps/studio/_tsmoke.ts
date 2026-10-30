import { readFileSync } from 'fs';
const f = 'apps/studio/src/scene/TwinSceneController.ts';
const src = readFileSync(f, 'utf8');
const t = new Bun.Transpiler({ loader: 'ts', target: 'esnext' });
try {
  t.transformSync(src, { filename: f });
  console.log('TRANSFORM OK: TwinSceneController.ts');
} catch (e) {
  console.log('TRANSFORM ERROR:', (e as Error).message);
}
