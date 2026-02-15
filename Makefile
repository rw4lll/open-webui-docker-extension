# =============================================================================
# Open WebUI Docker Extension — Makefile
# =============================================================================

# --- Configurable variables (override with env or CLI: make push-extension TAG=0.2.0) ---
IMAGE           ?= rw4lll/openwebui-docker-extension
TAG             ?= latest
DEV_IMAGE       ?= rw4lll/openwebui-docker-extension-dev
DEV_TAG         ?= dev
BUILDER         ?= buildx-multi-arch
# Docker images are always linux — covers Intel (amd64) and Apple Silicon (arm64)
PLATFORMS       ?= linux/amd64,linux/arm64
EXTRA_TAGS      ?=
ALLOW_OVERWRITE ?= 0

# --- Prettier file globs (shared between format / format-check) ---
FMT_GLOBS = "ui/src/**/*.{ts,tsx,js,jsx}" \
            "ui/test/**/*.{ts,tsx}" \
            "ui/*.{ts,tsx,js,jsx,json}" \
            "ui/vite.config.ts" \
            "ui/eslint.config.js"

# --- Colours for help output ---
INFO_COLOR = \033[0;36m
NO_COLOR   = \033[m

# --- Default target ---
.DEFAULT_GOAL := help

# =============================================================================
# Build
# =============================================================================

build-extension: ## Build extension image locally
	docker build --tag=$(IMAGE):$(TAG) .

prepare-buildx: ## Create buildx builder for multi-arch build, if not exists
	@docker buildx inspect $(BUILDER) >/dev/null 2>&1 \
		|| docker buildx create --name=$(BUILDER) --driver=docker-container --driver-opt=network=host

# =============================================================================
# Install / Update / Uninstall
# =============================================================================

install: build-extension ## Build and install the extension
	docker extension install -f $(IMAGE):$(TAG)

update-extension: build-extension ## Build and update an existing installation
	docker extension update $(IMAGE):$(TAG)

uninstall: ## Remove the extension from Docker Desktop
	docker extension rm $(IMAGE)

install-dev: ## Isolated dev install (does not touch published extension)
	@set -e; \
	docker build --tag=$(DEV_IMAGE):$(DEV_TAG) .; \
	if docker extension ls -q | grep -qxF '$(DEV_IMAGE)'; then \
		docker extension update $(DEV_IMAGE):$(DEV_TAG); \
	else \
		docker extension install -f $(DEV_IMAGE):$(DEV_TAG); \
	fi

install-dev-debug: ## Dev install + enable debug UI source
	@set -e; \
	$(MAKE) install-dev; \
	docker extension dev reset $(DEV_IMAGE) || true; \
	docker extension dev debug $(DEV_IMAGE)

uninstall-dev: ## Remove the dev extension from Docker Desktop
	docker extension rm $(DEV_IMAGE)

# =============================================================================
# Publish
# =============================================================================

push-extension: prepare-buildx ## Build & push multi-arch image (fails if tag exists; ALLOW_OVERWRITE=1 to force)
	@set -e; \
	if [ "$(ALLOW_OVERWRITE)" != "1" ] && docker pull $(IMAGE):$(TAG) >/dev/null 2>&1; then \
		echo "Error: tag $(IMAGE):$(TAG) already exists. Set ALLOW_OVERWRITE=1 to force." >&2; \
		exit 1; \
	fi; \
	if [ "$(ALLOW_OVERWRITE)" = "1" ]; then \
		echo "Warning: overwriting existing tag $(IMAGE):$(TAG)"; \
	fi; \
	TAG_ARGS="--tag $(IMAGE):$(TAG)"; \
	for tag in $(EXTRA_TAGS); do \
		TAG_ARGS="$$TAG_ARGS --tag $(IMAGE):$$tag"; \
	done; \
	docker buildx build --push --builder=$(BUILDER) --platform=$(PLATFORMS) --build-arg TAG=$(TAG) $$TAG_ARGS .

# =============================================================================
# Code quality
# =============================================================================

lint: ## Run ESLint on the UI (fail on warnings)
	cd ui && npm run lint

lint-fix: ## Auto-fix ESLint issues in the UI
	cd ui && npm run lint:fix

format: ## Format UI sources with Prettier
	npm exec --prefix ui prettier -- --write $(FMT_GLOBS)

format-check: ## Check UI formatting (CI-friendly, no writes)
	npm exec --prefix ui prettier -- --check $(FMT_GLOBS)

# =============================================================================
# Test
# =============================================================================

test: ## Run unit tests
	cd ui && npm test

test-coverage: ## Run unit tests with coverage report
	cd ui && npm test -- --coverage

# =============================================================================
# Cleanup
# =============================================================================

clean: ## Remove locally-built extension images
	@docker rmi $(IMAGE):$(TAG) 2>/dev/null || true
	@docker rmi $(DEV_IMAGE):$(DEV_TAG) 2>/dev/null || true

# =============================================================================
# Help
# =============================================================================

help: ## Show this help
	@echo "Available targets:"
	@echo ""
	@grep -E '^[0-9a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "$(INFO_COLOR)  %-22s$(NO_COLOR) %s\n", $$1, $$2}'

# =============================================================================
# Phony declarations (all targets are phony — none produce files)
# =============================================================================

.PHONY: build-extension prepare-buildx \
        install update-extension uninstall \
        install-dev install-dev-debug uninstall-dev \
        push-extension \
        lint lint-fix format format-check \
        test test-coverage \
        clean help
