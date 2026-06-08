# Deployment Scripts

This directory contains scripts for deploying and managing the Tanglement.ai teaser site.

## Scripts

### `deploy-poll.sh`

Automated deployment polling script that:
- Polls GitHub Gist for deployment notifications
- Pulls new Docker images when available
- Deploys updates automatically
- Updates deployment status

**Usage:**
```bash
# Set environment variables
export DEPLOYMENT_GIST_ID="your_gist_id"
export GIST_TOKEN="your_github_token"

# Run poller
./deploy-poll.sh
```

Or run as systemd service (see `tanglement-deploy-poll.service`).

### `setup-deployment.sh`

One-command setup script that configures everything:
- Checks dependencies (Docker, docker-compose, curl, jq)
- Creates directory structure
- Downloads configuration files
- Sets up environment variables
- Configures deployment poller
- Performs initial deployment

**Usage:**
```bash
sudo ./setup-deployment.sh
```

## Systemd Service

### `tanglement-deploy-poll.service`

Systemd service file for running the deployment poller as a system service.

**Installation:**
```bash
sudo cp tanglement-deploy-poll.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tanglement-deploy-poll
sudo systemctl start tanglement-deploy-poll
```

**Management:**
```bash
# Check status
sudo systemctl status tanglement-deploy-poll

# View logs
sudo journalctl -u tanglement-deploy-poll -f

# Restart
sudo systemctl restart tanglement-deploy-poll

# Stop
sudo systemctl stop tanglement-deploy-poll
```

## Configuration

All scripts use environment variables for configuration. See main deployment documentation at `../docs/DEPLOYMENT.md` for complete configuration details.

## Quick Start

### For TrueNAS Scale or Generic Linux

```bash
# 1. Download and run setup script
curl -sL https://raw.githubusercontent.com/tanglement-ai/tanglement.ai/main/packages/teaser-site/scripts/setup-deployment.sh -o setup-deployment.sh
chmod +x setup-deployment.sh
sudo ./setup-deployment.sh

# 2. Edit environment variables
sudo nano /opt/tanglement/teaser-site/.env

# 3. Restart services
cd /opt/tanglement/teaser-site
sudo docker-compose restart
```

## Documentation

For complete deployment documentation, see:
- [Main Deployment Guide](../docs/DEPLOYMENT.md)
- [TrueNAS Scale Deployment](../docs/DEPLOYMENT.md#truenas-scale-deployment)
- [Generic Linux Deployment](../docs/DEPLOYMENT.md#generic-linux-deployment)
