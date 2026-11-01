// 从 mini-line 的黄金 trace 生成「被篡改的基线」：只改一条事件的 payload，
// 哈希字段故意保留原值——这正是伪造证据的典型形态（改了内容，忘了重算指纹）。
// 用法：bun examples/fault-injection/generate.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const source = 'examples/community/mini-line/expected/trace.json';

type Event = { payload?: Record<string, unknown> };
type Trace = { events: Event[] };

const trace = JSON.parse(readFileSync(join(repoRoot, source), 'utf-8')) as Trace;
const index = trace.events.findIndex((event) => typeof event.payload?.status === 'string');
if (index < 0) throw new Error('黄金 trace 里没有带 payload.status 的事件，注入点需要重新挑。');

const from = trace.events[index].payload!.status as string;
const to = from === 'idle' ? 'busy' : 'idle';
trace.events[index].payload!.status = to;

const pointer = `/events/${index}/payload/status`;
writeFileSync(join(here, 'tampered.json'), `${JSON.stringify(trace, null, 2)}\n`, 'utf-8');
writeFileSync(
  join(here, 'injection.json'),
  `${JSON.stringify({ source, pointer, from, to, note: '只改事件内容，不重算 eventHash/stateHash' }, null, 2)}\n`,
  'utf-8',
);
console.log(`注入 ${pointer}：${from} → ${to}`);
