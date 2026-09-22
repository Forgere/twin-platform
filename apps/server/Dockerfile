# Twin Platform 服务端镜像
#
# 服务端直接由 Bun 运行 TS（bun src/index.ts），无需单独 build 步骤；
# monorepo 的 workspace 符号链接由 bun install 在镜像内重建，
# @twin-platform/* 直接解析到 packages/*/src/index.ts（Bun 即时转译）。

# 与 CI 保持一致，避免行为漂移
FROM oven/bun:1.3.12

WORKDIR /app

# 依赖层缓存：只复制影响依赖解析的文件
COPY package.json bun.lock* ./
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

# 锁文件存在且想可复现就用 --frozen-lockfile；否则退化到普通 install。
# 注意：改了某个包的 dependencies（如 storage-postgres 提升 pg）后需先在本机
# `bun install` 刷新 bun.lock，再构建，否则镜像内依赖可能滞后。
RUN bun install --frozen-lockfile || bun install

ENV PORT=8787
EXPOSE 8787

# /api/health 受 TWIN_API_TOKEN 保护（未设 token 时全开放）。
# 探针带 Bearer：token 未设时发空串，服务端不鉴权 → 200；
# token 设了时发真实值 → 200。两者都能正确反映存活。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health',{headers:{'authorization':'Bearer '+(process.env.TWIN_API_TOKEN||'')}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "apps/server/src/index.ts"]
