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
LABEL org.opencontainers.image.title="Open WebUI for Docker Desktop" \
    org.opencontainers.image.description="Easily launch and manage Open WebUI with full Docker Model Runner integration. Start chatting with your AI models in just one click." \
    org.opencontainers.image.vendor="Sergei Shitikov" \
    com.docker.desktop.extension.api.version="0.4.2" \
    com.docker.desktop.extension.icon="https://raw.githubusercontent.com/rw4lll/open-webui-docker-extension/main/open-webui.svg" \
    com.docker.extension.publisher-url="https://github.com/rw4lll/open-webui-docker-extension" \
    com.docker.extension.categories="ai,developer-tools" \
    com.docker.extension.changelog="<p>Version 0.2.0</p><ul><li>Added OpenAI-compatible connection support for Docker Model Runner integration</li><li>Checking for image updates and offering an Update & Restart action</li><li>Improved container lifecycle management and error handling</li><li>Other improvements and bug fixes</li></ul>" \
    com.docker.extension.detailed-description="<h1>Open WebUI for Docker Desktop</h1><p>One-click installation and management of <a href='https://github.com/open-webui/open-webui'>Open WebUI</a> with seamless <strong>Docker Model Runner</strong> integration.</p><h2>Features</h2><ul><li><strong>One-Click Setup</strong> — Launch Open WebUI instantly with sensible defaults</li><li><strong>Docker Model Runner Integration</strong> — Chat with local AI models served by Docker Model Runner via OpenAI-compatible API</li><li><strong>Container Management</strong> — Start, stop, restart, and reconfigure from the extension UI</li><li><strong>Persistent Storage</strong> — Your data and model cache survive container restarts</li><li><strong>Configurable</strong> — Customize image, port, and provisioner mode</li></ul><h2>Getting Started</h2><ol><li>Install the extension from the Docker Desktop Marketplace</li><li>Click <strong>Start</strong> to launch Open WebUI</li><li>Open the web UI and start chatting with AI models</li></ol>" \
    com.docker.extension.screenshots='[{"alt":"Open WebUI extension dashboard showing the container ready state with a one-click launch button","url":"https://raw.githubusercontent.com/rw4lll/open-webui-docker-extension/main/screenshot-1.png"},{"alt":"Open WebUI conversation using a Docker Model Runner model inside the browser","url":"https://raw.githubusercontent.com/rw4lll/open-webui-docker-extension/main/screenshot-2.png"}]' \
    com.docker.extension.additional-urls='[{"title":"Documentation","url":"https://github.com/rw4lll/open-webui-docker-extension#readme"},{"title":"Issues","url":"https://github.com/rw4lll/open-webui-docker-extension/issues"},{"title":"Open WebUI Docs","url":"https://docs.openwebui.com"}]'

COPY docker-compose.yaml .
COPY metadata.json .
COPY open-webui.svg .
COPY --from=client-builder /ui/build ui

