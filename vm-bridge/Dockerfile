FROM nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
USER root
ARG OS_PACKAGE_REFRESH=2026-11-11
RUN test -n "$OS_PACKAGE_REFRESH" \
    && apk update \
    && apk upgrade \
    && test -z "$(apk version -q -l '<')" \
    && rm -f /var/cache/apk/*
USER 101:101
