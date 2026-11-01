#!/usr/bin/env node
// 发布入口：`bin/scene.mjs` 由 `bun build --target=node` 从本文件打包而来。
// 无条件执行——`cli.ts` 的入口守卫按文件名判断，打包后永远不会命中，
// 所以 CLI 的「可执行」与「可被测试 import」必须分成两个文件。
import { runCli } from './cli';

void runCli(process.argv.slice(2)).then((code) => process.exit(code));
