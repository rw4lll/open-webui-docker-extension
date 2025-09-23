FROM --platform=$BUILDPLATFORM node:24-alpine AS client-builder
WORKDIR /ui
# cache packages in layer
COPY ui/package.json /ui/package.json
COPY ui/package-lock.json /ui/package-lock.json
RUN --mount=type=cache,target=/usr/src/app/.npm \
    npm set cache /usr/src/app/.npm && \
    npm ci
# install
COPY ui /ui
RUN npm run build

FROM alpine:3.20
LABEL org.opencontainers.image.title="Open-WebUI Docker Extension" \
    org.opencontainers.image.description="Easily launch and manage Open WebUI with full Docker Model Runner integration. Start chatting with your AI models in just one click." \
    org.opencontainers.image.vendor="Sergei Shitikov" \
    com.docker.desktop.extension.api.version="0.4.2" \
    com.docker.desktop.extension.icon="open-webui.svg" \
    com.docker.extension.publisher-url="https://github.com/rw4lll/open-webui-extension" \
    com.docker.extension.categories="ai,developer-tools"

COPY docker-compose.yaml .
COPY metadata.json .
COPY open-webui.svg .
COPY --from=client-builder /ui/build ui

