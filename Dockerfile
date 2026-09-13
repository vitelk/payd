# Payd keeper — production image.
#
# The keeper is STATELESS. Everything it keeps on disk is a cache recomputable
# from the chain: deleting it costs time on the first tick, never data. Moving to
# another machine therefore loses nothing — with one exception, documented in
# docker-compose.yml: the IPFS pins.
#
#   docker build -t payd-keeper .
#   docker run --env-file .env -v payd-data:/app/data payd-keeper
FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

# Manifests first: the install layer is only rebuilt when dependencies change,
# not on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY offchain/package.json offchain/
RUN pnpm install --frozen-lockfile --filter offchain

COPY offchain/ offchain/

# **What `abis.test.ts` reads, and nothing more.** It asserts that every name the
# TypeScript claims exists is still declared by the contracts — the check that
# catches an ABI the contracts have moved on from. It scans five directories:
# `contracts/`, `contracts/interfaces`, `contracts/libraries` for what is
# declared, then `offchain/src` and `front/src` for what is referenced. A missing
# one is not a skipped check, it is `ENOENT scandir`, which fails `pnpm test` and
# therefore the image.
#
# Copied HERE and not in the runtime stage on purpose: the keeper never reads a
# .sol file and never serves the front. The final image copies only node_modules,
# offchain and the root manifest.
COPY contracts/ contracts/
COPY front/src/ front/src/

RUN pnpm --filter offchain typecheck && pnpm --filter offchain test

# ---------------------------------------------------------------- runtime
FROM node:22-alpine

# Unprivileged user. The container holds a private key: nothing here justifies
# running as root.
RUN addgroup -S keeper && adduser -S keeper -G keeper
WORKDIR /app

COPY --from=build --chown=keeper:keeper /app/node_modules node_modules
COPY --from=build --chown=keeper:keeper /app/offchain offchain
COPY --from=build --chown=keeper:keeper /app/package.json ./

# The epoch cache. Mounted as a volume, it survives a restart and avoids
# replaying the whole history; lost, it rebuilds itself.
RUN mkdir -p /app/data && chown keeper:keeper /app/data
VOLUME /app/data
ENV EPOCH_DIR=/app/data

USER keeper

# The keeper loops every 60 s and survives its own errors. If it dies anyway
# that is a defect: we want the orchestrator to restart it.
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m \
  CMD node -e "process.exit(0)"

# Run through `tsx`, like package.json and docs/CONVENTIONS.md do, and not through
# `node --experimental-strip-types`.
#
# Stripping types is not the same as resolving them. The sources import
# `./config.js` — the TypeScript convention for NodeNext — and Node takes that
# specifier literally: no config.js exists, so the process died on
# ERR_MODULE_NOT_FOUND before printing anything. The image built fine, because
# the build stage uses tsx via pnpm; only the container was dead, and it would
# have crash-looped on the host.
#
# `tsx` is a devDependency, and it is deliberately kept in the runtime image:
# it IS the runtime everywhere else in this repo.
CMD ["offchain/node_modules/.bin/tsx", "offchain/src/keeper.ts"]
