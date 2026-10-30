import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '../../..');
const text = (path: string) => readFileSync(path, 'utf8');
const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
  return /\.(?:tsx?|css)$/.test(path) && !/\.test\./.test(path) ? [path] : [];
});

/** 用语法树跳过类型依赖；纯入口的运行时依赖图不得偷偷触达浏览器实现。 */
function imports(path: string): string[] {
  const source = ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly));
      if (!onlyTypes) result.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const onlyTypes = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((item) => item.isTypeOnly);
      if (!onlyTypes) result.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function localModule(from: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else if (specifier.startsWith('@twin-platform/')) {
    const [name, ...parts] = specifier.slice('@twin-platform/'.length).split('/');
    const dir = join(root, 'packages', name!);
    const manifest = JSON.parse(text(join(dir, 'package.json')));
    const exported = manifest.exports[parts.length ? './' + parts.join('/') : '.'];
    if (typeof exported !== 'string') throw new Error(`Unknown workspace export: ${specifier}`);
    base = resolve(dir, exported);
  } else return undefined;
  const path = [base, base + '.ts', base + '.tsx', join(base, 'index.ts')].find((file) => existsSync(file) && /\.(?:ts|tsx)$/.test(file));
  if (!path) throw new Error(`Cannot resolve ${specifier} from ${relative(root, from)}`);
  return path;
}

function assertHeadless(entry: string): void {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    expect(relative(root, path)).not.toMatch(/(?:^apps\/studio\/|\/studio\/|studio-sdk\/)/);
    for (const specifier of imports(path)) {
      expect(specifier).not.toMatch(/^(?:solid-js|@solidjs\/|three(?:\/|$)|camera-controls)/);
      const dependency = localModule(path, specifier);
      if (dependency) visit(dependency);
    }
  };
  visit(join(root, entry));
}

test('core modules do not import domain plugins', () => {
  for (const name of ['world-kernel', 'scene-schema', 'plugin-sdk', 'replay-core', 'decision-core', 'analytics-core', 'scenario-compare']) {
    for (const path of sourceFiles(join(root, 'packages', name, 'src'))) {
      expect(text(path)).not.toMatch(/['"]@twin-platform\/plugins-/);
    }
  }
});

test('domain and headless catalog entry graphs stay free of browser dependencies', () => {
  assertHeadless('packages/plugins-fishing/src/index.ts');
  // catalog 本身位于 Studio；逐个检查它的领域依赖，且不可引入浏览器装配表。
  const catalog = join(root, 'apps/studio/src/plugins/catalog.ts');
  for (const specifier of imports(catalog)) {
    const dependency = localModule(catalog, specifier);
    if (dependency) assertHeadless(relative(root, dependency));
  }
});

test('Studio only knows the fishing plugin at explicit composition roots', () => {
  const allowed = new Set(['plugins/catalog.ts', 'plugins/presentations.ts']);
  const dir = join(root, 'apps/studio/src');
  for (const path of sourceFiles(dir)) {
    if (allowed.has(relative(dir, path))) continue;
    expect({ file: relative(dir, path), leak: /fishing|\b(?:rig|bait|pond|hook|float)-\d|钓[鱼场组]/i.test(text(path)) }).toEqual({ file: relative(dir, path), leak: false });
  }
});

test('fishing browser implementation never imports the Studio application', () => {
  for (const path of sourceFiles(join(root, 'packages/plugins-fishing/studio'))) {
    if (path.endsWith('.css')) continue;
    for (const specifier of imports(path)) {
      expect(specifier).not.toMatch(/(?:apps\/studio|@twin-platform\/studio(?:\/|$))/);
      if (specifier.startsWith('.')) expect(relative(root, resolve(dirname(path), specifier))).not.toMatch(/^apps\//);
    }
  }
});
