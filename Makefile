IMAGE?=rw4lll/openwebui-docker-extension
TAG?=latest

BUILDER=buildx-multi-arch

INFO_COLOR = \033[0;36m
NO_COLOR   = \033[m

build-extension: ## Build service image to be deployed as a desktop extension
	docker build --tag=$(IMAGE):$(TAG) .

install-extension: build-extension ## Install the extension
	docker extension install $(IMAGE):$(TAG)

update-extension: build-extension ## Update the extension
	docker extension update $(IMAGE):$(TAG)

prepare-buildx: ## Create buildx builder for multi-arch build, if not exists
	docker buildx inspect $(BUILDER) || docker buildx create --name=$(BUILDER) --driver=docker-container --driver-opt=network=host

push-extension: prepare-buildx ## Build & Upload extension image to hub. Do not push if tag already exists: make push-extension tag=0.1
	docker pull $(IMAGE):$(TAG) && echo "Failure: Tag already exists" || docker buildx build --push --builder=$(BUILDER) --platform=linux/amd64,linux/arm64 --build-arg TAG=$(TAG) --tag=$(IMAGE):$(TAG) .

help: ## Show this help
	@echo Please specify a build target. The choices are:
	@grep -E '^[0-9a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "$(INFO_COLOR)%-30s$(NO_COLOR) %s\n", $$1, $$2}'

.PHONY: help

# --- Linting & Formatting ---
lint: ## Run ESLint on the UI (fail on warnings)
	cd ui && npm run lint

lint-fix: ## Fix ESLint issues in the UI
	cd ui && npm run lint:fix

format: ## Format the UI workspace with Prettier
	npm exec --prefix ui prettier -- --write "ui/src/**/*.{ts,tsx,js,jsx}" "ui/test/**/*.{ts,tsx}" "ui/*.{ts,tsx,js,jsx,json}" "ui/vite.config.ts" "ui/eslint.config.js"

format-check: ## Check formatting in the UI workspace
	npm exec --prefix ui prettier -- --check "ui/src/**/*.{ts,tsx,js,jsx}" "ui/test/**/*.{ts,tsx}" "ui/*.{ts,tsx,js,jsx,json}" "ui/vite.config.ts" "ui/eslint.config.js"
