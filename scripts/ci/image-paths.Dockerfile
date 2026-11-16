FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS inventory
RUN --network=none --mount=type=bind,from=subject,target=/image,readonly \
    node --input-type=module -e 'import { readdirSync, writeFileSync } from "node:fs"; import { join, relative } from "node:path"; const paths = readdirSync("/image", { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => relative("/image", join(entry.parentPath, entry.name))).sort(); if (!paths.length) throw new Error("Image lists no files"); writeFileSync("/paths.json", JSON.stringify(paths));'
FROM scratch
COPY --from=inventory /paths.json /paths.json
