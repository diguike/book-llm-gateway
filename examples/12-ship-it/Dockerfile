# 多阶段构建. 参考资料:
#   https://docs.docker.com/build/building/best-practices/
#   https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
#
# 三阶段:
#   1. deps     : 安装 production + dev deps (含 better-sqlite3 native 编译)
#   2. builder  : 跑 typecheck 验证 (build = tsc --noEmit, 教学版直接 tsx 跑 src,
#                 不需要落 dist; 生产想用 dist 见 DEPLOYMENT.md 的 Node.js 一节).
#   3. runner   : 仅复制需要的部分, 非 root 用户运行, 装 HEALTHCHECK.
#
# 镜像大小: ~250MB (slim 基底 + native 模块). alpine 能压到 ~150MB 但 better-sqlite3
# 的 musl libc 兼容性是个老问题, 教学版稳妥起见用 slim. 如果你的 CI 严格要求 alpine,
# 把 -slim 全部换 -alpine, RUN apt-get 换成 RUN apk add --no-cache python3 make g++.
#
# 镜像源: NODE_IMAGE 默认 docker.io/library/node, 国内 / 内网环境可以传 build arg
# 切到 daocloud 或公司私有 registry, 例如:
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node .

ARG NODE_VERSION=20
ARG NODE_IMAGE=node
# 默认 -slim (Debian glibc), 内网 / Bun 兼容场景可以传 alpine.
ARG NODE_VARIANT=slim
# native 模块装包命令: slim 用 apt-get, alpine 用 apk.
ARG INSTALL_BUILD_DEPS="apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*"

# ---------- stage 1: deps ----------
FROM ${NODE_IMAGE}:${NODE_VERSION}-${NODE_VARIANT} AS deps
WORKDIR /app
# native 模块编译依赖 (better-sqlite3 需要 python + g++)
ARG INSTALL_BUILD_DEPS
RUN sh -c "$INSTALL_BUILD_DEPS"
COPY package.json package-lock.json* ./
# CI 等价命令: 完全凭 lockfile, 不允许改
RUN npm ci

# ---------- stage 2: builder ----------
FROM ${NODE_IMAGE}:${NODE_VERSION}-${NODE_VARIANT} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 跑 typecheck, 失败时整个镜像构建失败
RUN npm run build

# ---------- stage 3: runner ----------
FROM ${NODE_IMAGE}:${NODE_VERSION}-${NODE_VARIANT} AS runner
WORKDIR /app
ENV NODE_ENV=prod
# 非 root 用户运行 (Node 官方镜像已经预置 'node' uid=1000)
RUN mkdir -p /app/data && chown -R node:node /app

# 只复制 prod deps + 已编译的 dist + migration. 不带额外文档 / 测试.
# 这样最终镜像更小, 攻击面更窄.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
# 教学版镜像直接跑 src/index.ts (用 tsx). 生产部署可以改成 tsc 编译后的 dist/index.js,
# 见 DEPLOYMENT.md 的 Node.js 部署一节.
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json

USER node

# 健康检查: docker 自带 HEALTHCHECK 跑 /healthz (liveness, 不依赖 DB).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
