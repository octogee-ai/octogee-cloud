FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS inventory
COPY image-paths.mjs /image-paths.mjs
RUN --network=none --mount=type=bind,from=subject,target=/image,readonly \
    node /image-paths.mjs /image > /paths.json
FROM scratch
COPY --from=inventory /paths.json /paths.json
