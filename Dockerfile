FROM node:26-alpine AS application

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack install --global pnpm@10.12.4
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/amazon-ads/package.json packages/amazon-ads/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/optimizer/package.json packages/optimizer/package.json

RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .
RUN pnpm build && mkdir -p /app/.data/reports && chown -R node:node /app/.data

USER node

FROM application AS api
EXPOSE 3000
CMD ["pnpm", "--filter", "@amazon-king/api", "start"]

FROM application AS worker
CMD ["pnpm", "--filter", "@amazon-king/worker", "start"]

FROM nginx:alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=application /app/apps/web/dist /usr/share/nginx/html
COPY privacy.html /usr/share/nginx/html/privacy.html
EXPOSE 8080
