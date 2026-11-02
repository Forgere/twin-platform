#!/usr/bin/env bun
/**
 * 顺序跑各包 + server + worker 的单测。
 *
 * Bun 1.3.x 在同一个 test runner 进程里并发加载文件时，
 * 加载慢的文件（scene-cli、studio-sdk/architecture）会在其他文件
 * 已经结束后才调用 beforeEach/describe，触发
 * "Cannot call X after the test run has completed"。
 *
 * 解法：每个包单独起一个 bun test 子进程，文件数少，加载时间短，
 * 不会互相竞争。总耗时与并发批次相差不大（I/O 为主，CPU 串行）。
 */
import { spawnSync } from 'bun';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dir.replace(/\/scripts$/, '');

function hasTests(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') {
        if (hasTests(p)) return true;
      } else if (e.isFile() && e.name.endsWith('.test.ts')) {
        return true;
      }
    }
  } catch { /* dir does not exist */ }
  return false;
}

const targets: string[] = [];

// packages/*
for (const name of readdirSync(join(root, 'packages'))) {
  const dir = join(root, 'packages', name);
  if (!statSync(dir).isDirectory()) continue;
  if (hasTests(join(dir, 'src'))) targets.push(dir);
}

// apps/server and apps/worker
for (const name of ['apps/server', 'apps/worker']) {
  const dir = join(root, name);
  if (hasTests(join(dir, 'src'))) targets.push(dir);
}

let failed = false;
let totalPass = 0;
let totalFail = 0;

for (const target of targets) {
  const result = spawnSync(['bun', 'test', target, '--path-ignore-patterns', '**/studio/**'], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) failed = true;
  // parse summary from stderr/stdout is impractical; rely on exit codes
}

process.exit(failed ? 1 : 0);
