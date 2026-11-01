export type FlagValue = string | boolean;

export interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue>>;
}

export const USAGE = `scene —— 可验证场景命令行（run / audit / replay / diff / report）

用法：
  scene <command> [选项]

命令：
  run     执行一次运行，产出 trace + 报告（默认不因不变量失败而退出非 0，加 --strict 才挡）
  audit   执行一次运行，并按不变量 / 基线门禁判定（失败即退出 1）
  replay  重跑场景并与黄金基线 trace 比对（需要 --baseline；基线缺失时 --update 生成）
  diff    比较两个已有 trace 文件（位置参数：<current> <baseline>）
  report  用已有 trace / report 渲染 HTML 报告（位置参数：<trace.json> [report.json]）
  verify  验收外部 trace：结构 / 事件顺序 / 本端重算哈希（位置参数：<trace.json>）
  package 校验 scene package 目录：布局 / 场景 / 插件锁 / 时间网格 / 黄金基线（位置参数：<dir>）

常用选项：
  --package <dir>           场景包目录：scene.json + plugins.lock.json + seed.json（+ 可选 invariants/actions）
  --scene <file>            场景 JSON（版本化，可迁移）
  --template <id>           用参考插件模板建场景，如 logistics.center / fishing.pond
  --template-params <json>   模板参数（JSON 文件路径或直接 JSON 字符串）
  --plugin <id>              插件：none（默认）/ logistics / fishing
  --seed <n> --step <dt>    随机种子与固定步长
  --seconds <n> --steps <n> 运行时长（默认 60s）或步数，二者只能给一个
  --actions <file>          动作脚本 JSON（set-attr / dispatch / move / set-transform）
  --out <dir>               产物输出目录（trace.json / report.json / report.html）
  --junit <file>            JUnit XML 输出（可直接进 CI）
  --html <file>             HTML 报告输出路径
  --baseline <file>         黄金基线 trace
  --update                  把本次 trace 写成基线
  --strict                  run 命令也按不变量 / 基线结果退出非 0

退出码：0 通过 · 1 审计或差分失败 · 2 用法 / IO / 执行错误。
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  let command = '';
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') continue;
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) flags[body] = true;
        else {
          flags[body] = next;
          index += 1;
        }
      }
      continue;
    }
    if (command === '') command = token;
    else positionals.push(token);
  }
  return { command, positionals, flags };
}

export function flagString(flags: Readonly<Record<string, FlagValue>>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`选项 --${name} 需要一个值。`);
  return value;
}

export function flagNumber(flags: Readonly<Record<string, FlagValue>>, name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`选项 --${name} 必须是数字，收到 ${raw}。`);
  return value;
}

export function flagBoolean(flags: Readonly<Record<string, FlagValue>>, name: string): boolean {
  return flags[name] !== undefined;
}
