#!/usr/bin/env bash

# Tanglement.ai Teaser Site - Deployment Setup Script
# This script sets up automated deployment on TrueNAS Scale or generic Linux

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/tanglement/teaser-site"
CONFIG_DIR="/etc/tanglement"
LOG_DIR="/var/log/tanglement"
STATE_DIR="/var/lib/tanglement"

print_header() {
    echo -e "${BLUE}"
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║                                                          ║"
    echo "║   Tanglement.ai Teaser Site - Deployment Setup          ║"
    echo "║                                                          ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

log() {
    echo -e "${GREEN}[✓]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

error() {
    echo -e "${RED}[✗]${NC} $1"
    exit 1
}

check_root() {
    if [ "$EUID" -ne 0 ]; then
        error "This script must be run as root. Use: sudo ./setup-deployment.sh"
    fi
}

detect_system() {
    if [ -f /etc/truenas-version ]; then
        echo "truenas"
    elif [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    else
        echo "unknown"
    fi
}

check_dependencies() {
    log "Checking dependencies..."

    local missing=()

    command -v docker >/dev/null 2>&1 || missing+=("docker")
    command -v docker-compose >/dev/null 2>&1 || missing+=("docker-compose")
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v jq >/dev/null 2>&1 || missing+=("jq")

    if [ ${#missing[@]} -ne 0 ]; then
        warn "Missing dependencies: ${missing[*]}"
        read -p "Install missing dependencies? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            install_dependencies "${missing[@]}"
        else
            error "Required dependencies not installed"
        fi
    fi

    log "All dependencies satisfied"
}

install_dependencies() {
    local system=$(detect_system)
    log "Installing dependencies on $system..."

    case "$system" in
        ubuntu|debian)
            apt-get update
            apt-get install -y "$@"
            ;;
        fedora|centos|rhel)
            yum install -y "$@"
            ;;
        truenas)
            apt-get update
            apt-get install -y "$@"
            ;;
        *)
            error "Unsupported system: $system"
            ;;
    esac
}

create_directories() {
    log "Creating directory structure..."

    mkdir -p "$INSTALL_DIR"/{scripts,logs}
    mkdir -p "$CONFIG_DIR"
    mkdir -p "$LOG_DIR"
    mkdir -p "$STATE_DIR"

    log "Directories created"
}

download_files() {
    log "Downloading configuration files..."

    local base_url="https://raw.githubusercontent.com/tanglement-ai/tanglement.ai/main/packages/teaser-site"

    # Download docker-compose.yml
    curl -sL "$base_url/docker-compose.yml" -o "$INSTALL_DIR/docker-compose.yml"

    # Download deployment poller
    curl -sL "$base_url/scripts/deploy-poll.sh" -o "$INSTALL_DIR/scripts/deploy-poll.sh"
    chmod +x "$INSTALL_DIR/scripts/deploy-poll.sh"

    # Download systemd service
    curl -sL "$base_url/scripts/tanglement-deploy-poll.service" \
        -o /etc/systemd/system/tanglement-deploy-poll.service

    log "Files downloaded"
}

configure_environment() {
    log "Configuring environment..."

    if [ ! -f "$INSTALL_DIR/.env" ]; then
        cat > "$INSTALL_DIR/.env" <<EOF
# Tanglement.ai Teaser Site Environment Configuration
# Generated: $(date)

# Application
NODE_ENV=production
SITE_URL=https://tanglement.ai
NEXT_PUBLIC_SITE_URL=https://tanglement.ai

# Database (configure PostgreSQL connection)
DATABASE_URL=postgresql://tanglement:changeme@postgres:5432/tanglement
POSTGRES_USER=tanglement
POSTGRES_PASSWORD=$(openssl rand -base64 32)

# Email (SendGrid)
SENDGRID_API_KEY=
SENDGRID_FROM_EMAIL=hello@tanglement.ai

# Email Marketing (ConvertKit)
CONVERTKIT_API_KEY=
CONVERTKIT_FORM_ID=

# Analytics (Plausible)
NEXT_PUBLIC_PLAUSIBLE_DOMAIN=tanglement.ai

# Error Tracking (Sentry)
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=
EOF
        warn "Created .env file at $INSTALL_DIR/.env"
        warn "IMPORTANT: Edit this file and add your API keys!"
    else
        log ".env file already exists, skipping"
    fi
}

configure_deployment_poller() {
    log "Configuring deployment poller..."

    read -p "Enter GitHub Gist ID: " gist_id
    read -p "Enter GitHub Personal Access Token: " -s gist_token
    echo

    cat > "$CONFIG_DIR/deployment.env" <<EOF
# Deployment Poller Configuration
DEPLOYMENT_GIST_ID=$gist_id
GIST_TOKEN=$gist_token
DEPLOYMENT_ENVIRONMENT=production
POLL_INTERVAL=60
COMPOSE_FILE=$INSTALL_DIR/docker-compose.yml
SERVICE_NAME=teaser-site
STATE_FILE=$STATE_DIR/deployment-state.json
LOG_FILE=$LOG_DIR/deployment.log
EOF

    chmod 600 "$CONFIG_DIR/deployment.env"
    log "Deployment poller configured"
}

update_systemd_service() {
    log "Updating systemd service paths..."

    sed -i "s|/opt/tanglement|$INSTALL_DIR|g" \
        /etc/systemd/system/tanglement-deploy-poll.service

    systemctl daemon-reload
    log "Systemd service updated"
}

initial_deployment() {
    log "Performing initial deployment..."

    cd "$INSTALL_DIR"

    # Pull images
    docker-compose pull

    # Start services
    docker-compose up -d

    # Wait for health check
    sleep 10

    if docker-compose ps | grep -q "Up"; then
        log "Initial deployment successful"
    else
        warn "Initial deployment may have issues. Check logs: docker-compose logs"
    fi
}

enable_deployment_poller() {
    log "Enabling deployment poller..."

    systemctl enable tanglement-deploy-poll
    systemctl start tanglement-deploy-poll

    sleep 2

    if systemctl is-active --quiet tanglement-deploy-poll; then
        log "Deployment poller started successfully"
    else
        warn "Deployment poller failed to start. Check: systemctl status tanglement-deploy-poll"
    fi
}

print_summary() {
    echo -e "\n${GREEN}╔══════════════════════════════════════════════════════════╗"
    echo "║                                                          ║"
    echo "║   Setup Complete!                                        ║"
    echo "║                                                          ║"
    echo "╚══════════════════════════════════════════════════════════╝${NC}\n"

    echo "Installation Directory: $INSTALL_DIR"
    echo "Configuration Directory: $CONFIG_DIR"
    echo "Log Directory: $LOG_DIR"
    echo ""
    echo "Next Steps:"
    echo "1. Edit environment variables: nano $INSTALL_DIR/.env"
    echo "2. Check application: docker-compose -f $INSTALL_DIR/docker-compose.yml ps"
    echo "3. View logs: docker-compose -f $INSTALL_DIR/docker-compose.yml logs -f"
    echo "4. Check poller: systemctl status tanglement-deploy-poll"
    echo "5. View poller logs: journalctl -u tanglement-deploy-poll -f"
    echo ""
    echo "Application URL: http://$(hostname -I | awk '{print $1}'):3000"
    echo ""
}

main() {
    print_header

    check_root
    check_dependencies
    create_directories
    download_files
    configure_environment
    configure_deployment_poller
    update_systemd_service
    initial_deployment
    enable_deployment_poller

    print_summary
}

# Run main function
main "$@"
