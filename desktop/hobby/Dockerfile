ARG GATEWAY_IMAGE
FROM ${GATEWAY_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server tigervnc-tools openbox xterm pcmanfm \
    dbus-x11 at-spi2-core wmctrl x11-utils xdotool \
    && rm -rf /var/lib/apt/lists/*
COPY desktop/hobby /benchmark
COPY desktop/acceptance /benchmark/desktop/acceptance
COPY scripts/lib/openclaw-computer-browser.ts /benchmark/scripts/lib/openclaw-computer-browser.ts
RUN chmod 755 /benchmark/*.sh
USER node
ENTRYPOINT ["/benchmark/start.sh"]
