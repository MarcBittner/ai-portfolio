#!/usr/bin/env bash

# Tanglement.ai Teaser Site - Deployment Polling Script
# This script polls a GitHub Gist for deployment notifications and triggers deployments

set -euo pipefail

# ============================================
# Configuration
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Gist configuration (set via environment variables or .env file)
GIST_ID="${DEPLOYMENT_GIST_ID:-}"
GIST_TOKEN="${GIST_TOKEN:-}"
POLL_INTERVAL="${POLL_INTERVAL:-60}"  # seconds
ENVIRONMENT="${DEPLOYMENT_ENVIRONMENT:-production}"

# Docker configuration
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SERVICE_NAME="${SERVICE_NAME:-teaser-site}"

# Paths
STATE_FILE="${STATE_FILE:-/var/lib/tanglement/deployment-state.json}"
LOG_FILE="${LOG_FILE:-/var/log/tanglement/deployment.log}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================
# Functions
# ============================================

log() {
    local level="$1"
    shift
    local message="$@"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Color based on level
    local color=""
    case "$level" in
        ERROR)   color="$RED" ;;
        SUCCESS) color="$GREEN" ;;
        WARN)    color="$YELLOW" ;;
        INFO)    color="$BLUE" ;;
    esac

    echo -e "${color}[$timestamp] [$level]${NC} $message" | tee -a "$LOG_FILE"
}

check_requirements() {
    log INFO "Checking requirements..."

    local missing=()

    command -v docker >/dev/null 2>&1 || missing+=("docker")
    command -v docker-compose >/dev/null 2>&1 || missing+=("docker-compose")
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v jq >/dev/null 2>&1 || missing+=("jq")

    if [ ${#missing[@]} -ne 0 ]; then
        log ERROR "Missing required commands: ${missing[*]}"
        log ERROR "Install with: apt-get install ${missing[*]}"
        exit 1
    fi

    if [ -z "$GIST_ID" ]; then
        log ERROR "DEPLOYMENT_GIST_ID not set"
        exit 1
    fi

    log SUCCESS "All requirements met"
}

fetch_deployment_status() {
    log INFO "Fetching deployment status from gist..."

    local url="https://gist.githubusercontent.com/tanglement-ai/$GIST_ID/raw/deployment.json"

    if [ -n "$GIST_TOKEN" ]; then
        curl -sf -H "Authorization: token $GIST_TOKEN" "$url"
    else
        curl -sf "$url"
    fi
}

get_current_state() {
    if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
    else
        echo '{"version":"","deployed":false}'
    fi
}

save_state() {
    local state="$1"
    mkdir -p "$(dirname "$STATE_FILE")"
    echo "$state" > "$STATE_FILE"
}

deployment_required() {
    local remote_status="$1"
    local current_state="$2"

    local remote_version=$(echo "$remote_status" | jq -r '.version')
    local remote_required=$(echo "$remote_status" | jq -r '.deployment_required')
    local remote_env=$(echo "$remote_status" | jq -r '.environment')
    local remote_deployed=$(echo "$remote_status" | jq -r '.deployed')

    local current_version=$(echo "$current_state" | jq -r '.version')

    # Check if deployment is required for our environment
    if [ "$remote_env" != "$ENVIRONMENT" ]; then
        return 1  # Not for our environment
    fi

    if [ "$remote_required" != "true" ]; then
        return 1  # Deployment not required
    fi

    if [ "$remote_deployed" == "true" ]; then
        return 1  # Already deployed
    fi

    if [ "$remote_version" == "$current_version" ]; then
        return 1  # Same version already deployed
    fi

    return 0  # Deployment required
}

pull_and_deploy() {
    local deployment_info="$1"

    local version=$(echo "$deployment_info" | jq -r '.version')
    local image=$(echo "$deployment_info" | jq -r '.image')

    log INFO "Deploying version: $version"
    log INFO "Image: $image"

    cd "$PROJECT_DIR"

    # Pull latest image
    log INFO "Pulling Docker image..."
    if ! docker-compose -f "$COMPOSE_FILE" pull "$SERVICE_NAME"; then
        log ERROR "Failed to pull Docker image"
        return 1
    fi

    # Stop current container
    log INFO "Stopping current container..."
    docker-compose -f "$COMPOSE_FILE" stop "$SERVICE_NAME" || true

    # Start new container
    log INFO "Starting new container..."
    if ! docker-compose -f "$COMPOSE_FILE" up -d "$SERVICE_NAME"; then
        log ERROR "Failed to start container"
        # Attempt rollback
        log WARN "Attempting rollback..."
        docker-compose -f "$COMPOSE_FILE" up -d "$SERVICE_NAME"
        return 1
    fi

    # Wait for health check
    log INFO "Waiting for health check..."
    local retries=30
    local count=0
    while [ $count -lt $retries ]; do
        if docker-compose -f "$COMPOSE_FILE" ps "$SERVICE_NAME" | grep -q "healthy\|Up"; then
            log SUCCESS "Container is healthy"
            break
        fi
        sleep 2
        count=$((count + 1))
    done

    if [ $count -eq $retries ]; then
        log ERROR "Health check failed"
        return 1
    fi

    # Cleanup old images
    log INFO "Cleaning up old images..."
    docker image prune -f

    log SUCCESS "Deployment completed successfully"
    return 0
}

update_gist_status() {
    local deployment_info="$1"
    local success="$2"

    if [ -z "$GIST_TOKEN" ]; then
        log WARN "No GIST_TOKEN set, cannot update deployment status"
        return 0
    fi

    local version=$(echo "$deployment_info" | jq -r '.version')
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local updated_status=$(echo "$deployment_info" | jq \
        --arg deployed "$success" \
        --arg deployed_at "$timestamp" \
        --arg deployed_by "$(hostname)" \
        '.deployed = ($deployed == "true") | .deployed_at = $deployed_at | .deployed_by = $deployed_by | .deployment_required = false')

    log INFO "Updating gist with deployment status..."

    # Update gist via API
    local gist_url="https://api.github.com/gists/$GIST_ID"

    curl -sf -X PATCH \
        -H "Authorization: token $GIST_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "$gist_url" \
        -d "{\"files\":{\"deployment.json\":{\"content\":$(echo "$updated_status" | jq -R -s .)}}}" \
        >/dev/null

    log SUCCESS "Gist updated with deployment status"
}

poll_loop() {
    log INFO "Starting deployment poll loop (interval: ${POLL_INTERVAL}s, environment: $ENVIRONMENT)"

    while true; do
        local remote_status
        if remote_status=$(fetch_deployment_status 2>&1); then
            local current_state=$(get_current_state)

            if deployment_required "$remote_status" "$current_state"; then
                log INFO "New deployment detected"

                if pull_and_deploy "$remote_status"; then
                    log SUCCESS "Deployment successful"
                    save_state "$remote_status"
                    update_gist_status "$remote_status" "true"
                else
                    log ERROR "Deployment failed"
                    update_gist_status "$remote_status" "false"
                fi
            else
                log INFO "No deployment required (current: $(echo "$current_state" | jq -r '.version // "none"'))"
            fi
        else
            log WARN "Failed to fetch deployment status: $remote_status"
        fi

        sleep "$POLL_INTERVAL"
    done
}

# ============================================
# Main
# ============================================

main() {
    # Load environment file if exists
    if [ -f "$PROJECT_DIR/.env.deployment" ]; then
        log INFO "Loading environment from .env.deployment"
        set -a
        source "$PROJECT_DIR/.env.deployment"
        set +a
    fi

    # Create log directory
    mkdir -p "$(dirname "$LOG_FILE")"

    log INFO "=== Tanglement.ai Deployment Poller Starting ==="
    log INFO "Project: $PROJECT_DIR"
    log INFO "Environment: $ENVIRONMENT"
    log INFO "Compose File: $COMPOSE_FILE"
    log INFO "Service: $SERVICE_NAME"

    check_requirements
    poll_loop
}

# Handle script execution
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
