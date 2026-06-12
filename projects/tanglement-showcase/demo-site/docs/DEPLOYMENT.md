# Tanglement.ai Teaser Site - Deployment Guide

This document covers all deployment methods for the Tanglement.ai teaser site using a **build-push-pull** strategy with GitHub Actions and automated deployment polling.

---

## 📋 Table of Contents

1. [Deployment Architecture](#deployment-architecture)
2. [Prerequisites](#prerequisites)
3. [GitHub Actions Setup](#github-actions-setup)
4. [TrueNAS Scale Deployment](#truenas-scale-deployment)
5. [Generic Linux Deployment](#generic-linux-deployment)
6. [Environment Variables](#environment-variables)
7. [Monitoring & Logs](#monitoring--logs)
8. [Troubleshooting](#troubleshooting)

---

## 🏗️ Deployment Architecture

### Build-Push-Pull Strategy

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   GitHub     │         │   GitHub     │         │  Deployment  │
│   Actions    │ ──────> │ Gist (Status)│ <────── │   Server     │
│   (Build)    │         │              │         │   (Poll)     │
└──────────────┘         └──────────────┘         └──────────────┘
       │                                                   │
       │ Push Image                                       │ Pull Image
       ▼                                                   ▼
┌──────────────┐                                   ┌──────────────┐
│    GitHub    │ ◄─────────────────────────────────│    Docker    │
│   Container  │                                   │    Daemon    │
│   Registry   │                                   │              │
└──────────────┘                                   └──────────────┘
```

### Flow:

1. **Build**: GitHub Actions builds Docker image on `git push`
2. **Push**: Image pushed to GitHub Container Registry (ghcr.io)
3. **Notify**: GitHub Actions writes deployment status to Gist
4. **Poll**: Deployment server polls Gist every 60 seconds
5. **Pull**: When new deployment detected, server pulls image
6. **Deploy**: Server runs `docker-compose up -d` with new image
7. **Update**: Server updates Gist with deployment success/failure

---

## ✅ Prerequisites

### All Deployments

- Docker 24+ installed
- Docker Compose v2+ installed
- Internet access to ghcr.io
- GitHub Personal Access Token with gist permissions

### TrueNAS Scale Specific

- TrueNAS Scale 23.10+ (Dragonfish)
- Custom App support enabled
- Dataset created for application data

### Generic Linux Specific

- Ubuntu 22.04+ or Debian 12+ recommended
- systemd for service management
- sudo access

---

## 🔐 GitHub Actions Setup

### Step 1: Create GitHub Gist

Create a new **secret** gist for deployment status:

1. Go to https://gist.github.com/
2. Create new gist
3. Filename: `deployment.json`
4. Content:
```json
{
  "service": "teaser-site",
  "environment": "production",
  "version": "",
  "image": "",
  "digest": "",
  "timestamp": "",
  "deployed": false,
  "deployment_required": false
}
```
5. Create **Secret** Gist
6. Copy the Gist ID from the URL (e.g., `abc123def456`)

### Step 2: Create GitHub Personal Access Token

1. Go to https://github.com/settings/tokens
2. Generate new token (classic)
3. Scopes needed:
   - `gist` (create/update gists)
   - `read:packages` (read from ghcr.io)
4. Copy the token

### Step 3: Add GitHub Secrets

In your repository settings → Secrets and variables → Actions:

```
GIST_TOKEN          = <your_personal_access_token>
DEPLOYMENT_GIST_ID  = <your_gist_id>
```

### Step 4: Enable GitHub Container Registry

1. Go to repository Settings → Packages
2. Enable "Improve Container Support"
3. Make package public (or configure access)

### GitHub Actions Workflow

The workflow (`.github/workflows/deploy-teaser-site.yml`) automatically:

1. **On push to `main`**: Builds, tests, pushes to ghcr.io, updates gist
2. **On push to `develop`**: Builds, tests (no deployment)
3. **On PR**: Builds and tests only

---

## 🖥️ TrueNAS Scale Deployment

### Step 1: Create Datasets

```bash
# Via TrueNAS GUI: Storage → Create Dataset
# Or via CLI:
zfs create pool/apps/tanglement
zfs create pool/apps/tanglement/logs
zfs create pool/apps/tanglement/postgres
```

### Step 2: Install Custom App

#### Option A: Using TrueNAS GUI

1. Navigate to **Apps** → **Available Applications**
2. Click **Launch Docker Image**
3. Configure:
   - **Application Name**: `tanglement-teaser-site`
   - **Image Repository**: `ghcr.io/tanglement-ai/teaser-site`
   - **Image Tag**: `latest`
   - **Pull Policy**: `Always`

4. **Networking**:
   - **Network Mode**: Bridge
   - **Port Forwarding**: `3000:3000`

5. **Storage**:
   - **Host Path**: `/mnt/pool/apps/tanglement/logs`
   - **Mount Path**: `/app/logs`

6. **Environment Variables**: (See [Environment Variables](#environment-variables))

7. Click **Install**

#### Option B: Using Docker Compose (Advanced)

1. SSH into TrueNAS
2. Navigate to app directory:
```bash
cd /mnt/pool/apps/tanglement
```

3. Download docker-compose file:
```bash
curl -o docker-compose.yml \
  https://raw.githubusercontent.com/tanglement-ai/tanglement.ai/main/packages/teaser-site/docker-compose.truenas.yml
```

4. Create `.env` file:
```bash
cat > .env <<EOF
DATABASE_URL=postgresql://user:pass@postgres/tanglement
SENDGRID_API_KEY=your_sendgrid_key
SENDGRID_FROM_EMAIL=hello@tanglement.ai
# ... add all required env vars
EOF
```

5. Start services:
```bash
docker-compose up -d
```

### Step 3: Set Up Automated Deployment

1. Download deployment poller:
```bash
mkdir -p /mnt/pool/apps/tanglement/scripts
cd /mnt/pool/apps/tanglement/scripts

curl -o deploy-poll.sh \
  https://raw.githubusercontent.com/tanglement-ai/tanglement.ai/main/packages/teaser-site/scripts/deploy-poll.sh

chmod +x deploy-poll.sh
```

2. Create environment file:
```bash
cat > /etc/tanglement/deployment.env <<EOF
DEPLOYMENT_GIST_ID=your_gist_id
GIST_TOKEN=your_github_token
DEPLOYMENT_ENVIRONMENT=production
POLL_INTERVAL=60
COMPOSE_FILE=/mnt/pool/apps/tanglement/docker-compose.yml
SERVICE_NAME=teaser-site
STATE_FILE=/mnt/pool/apps/tanglement/deployment-state.json
LOG_FILE=/mnt/pool/apps/tanglement/logs/deployment.log
EOF
```

3. Create systemd service:
```bash
curl -o /etc/systemd/system/tanglement-deploy-poll.service \
  https://raw.githubusercontent.com/tanglement-ai/tanglement.ai/main/packages/teaser-site/scripts/tanglement-deploy-poll.service
```

4. Update paths in service file:
```bash
sed -i 's|/opt/tanglement|/mnt/pool/apps/tanglement|g' \
  /etc/systemd/system/tanglement-deploy-poll.service
```

5. Enable and start service:
```bash
systemctl daemon-reload
systemctl enable tanglement-deploy-poll
systemctl start tanglement-deploy-poll
```

6. Check status:
```bash
systemctl status tanglement-deploy-poll
journalctl -u tanglement-deploy-poll -f
```

### Step 4: Configure Reverse Proxy (Optional)

If using TrueNAS built-in reverse proxy or external Traefik:

```yaml
# Add labels to docker-compose.yml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.teaser-site.rule=Host(`tanglement.ai`)"
  - "traefik.http.routers.teaser-site.entrypoints=websecure"
  - "traefik.http.routers.teaser-site.tls.certresolver=letsencrypt"
```

---

## 🐧 Generic Linux Deployment

### Step 1: Install Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
  -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### Step 2: Create Application Directory

```bash
sudo mkdir -p /opt/tanglement/teaser-site
cd /opt/tanglement/teaser-site
```

### Step 3: Download Configuration Files

```bash
# Download docker-compose.yml
sudo curl -o docker-compose.yml \
  https://raw.githubusercontent.com/tanglement-ai/tanglement.ai/main/packages/teaser-site/docker-compose.yml

# Download deployment poller
sudo mkdir -p scripts
sudo curl -o scripts/deploy-poll.sh \
  https://raw.githubusercontent.com/tanglement-ai/tanglement.ai/main/packages/teaser-site/scripts/deploy-poll.sh
sudo chmod +x scripts/deploy-poll.sh
```

### Step 4: Configure Environment

```bash
# Create .env file
sudo tee .env > /dev/null <<EOF
# Database
DATABASE_URL=postgresql://USER:PASSWORD@postgres:5432/tanglement
POSTGRES_USER=tanglement
POSTGRES_PASSWORD=$(openssl rand -base64 32)

# Application
SITE_URL=https://tanglement.ai
NODE_ENV=production

# Email
SENDGRID_API_KEY=your_sendgrid_key
SENDGRID_FROM_EMAIL=hello@tanglement.ai

# Email Marketing
CONVERTKIT_API_KEY=your_convertkit_key
CONVERTKIT_FORM_ID=your_form_id

# Analytics
PLAUSIBLE_DOMAIN=tanglement.ai

# Error Tracking
SENTRY_DSN=your_sentry_dsn
NEXT_PUBLIC_SENTRY_DSN=your_public_sentry_dsn
EOF

# Create deployment poller environment
sudo tee /etc/tanglement/deployment.env > /dev/null <<EOF
DEPLOYMENT_GIST_ID=your_gist_id
GIST_TOKEN=your_github_token
DEPLOYMENT_ENVIRONMENT=production
POLL_INTERVAL=60
COMPOSE_FILE=/opt/tanglement/teaser-site/docker-compose.yml
SERVICE_NAME=teaser-site
STATE_FILE=/var/lib/tanglement/deployment-state.json
LOG_FILE=/var/log/tanglement/deployment.log
EOF
```

### Step 5: Initial Deployment

```bash
cd /opt/tanglement/teaser-site
sudo docker-compose pull
sudo docker-compose up -d
```

Verify:
```bash
sudo docker-compose ps
sudo docker-compose logs -f teaser-site
```

Visit: http://localhost:3000

### Step 6: Set Up Automated Deployment

```bash
# Install systemd service
sudo curl -o /etc/systemd/system/tanglement-deploy-poll.service \
  https://raw.githubusercontent.com/tanglement-ai/tanglement.ai/main/packages/teaser-site/scripts/tanglement-deploy-poll.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable tanglement-deploy-poll
sudo systemctl start tanglement-deploy-poll

# Check status
sudo systemctl status tanglement-deploy-poll
sudo journalctl -u tanglement-deploy-poll -f
```

### Step 7: Configure Firewall

```bash
# Allow port 3000
sudo ufw allow 3000/tcp

# Or if using reverse proxy
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### Step 8: Set Up Reverse Proxy (Nginx)

```bash
sudo apt install nginx certbot python3-certbot-nginx

# Create Nginx config
sudo tee /etc/nginx/sites-available/tanglement.ai > /dev/null <<EOF
server {
    listen 80;
    server_name tanglement.ai www.tanglement.ai;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

# Enable site
sudo ln -s /etc/nginx/sites-available/tanglement.ai /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d tanglement.ai -d www.tanglement.ai
```

---

## 🔧 Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `SENDGRID_API_KEY` | SendGrid API key | `SG.xxx...` |
| `SENDGRID_FROM_EMAIL` | Sender email address | `hello@tanglement.ai` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SITE_URL` | Public site URL | `https://tanglement.ai` |
| `CONVERTKIT_API_KEY` | ConvertKit API key | - |
| `CONVERTKIT_FORM_ID` | ConvertKit form ID | - |
| `PLAUSIBLE_DOMAIN` | Plausible analytics domain | `tanglement.ai` |
| `SENTRY_DSN` | Sentry error tracking DSN | - |
| `NEXT_PUBLIC_SENTRY_DSN` | Public Sentry DSN | - |

### Deployment Poller Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEPLOYMENT_GIST_ID` | GitHub Gist ID for deployment status | *required* |
| `GIST_TOKEN` | GitHub Personal Access Token | *required* |
| `DEPLOYMENT_ENVIRONMENT` | Environment name | `production` |
| `POLL_INTERVAL` | Polling interval in seconds | `60` |
| `COMPOSE_FILE` | Path to docker-compose.yml | `docker-compose.yml` |
| `SERVICE_NAME` | Docker service name | `teaser-site` |

---

## 📊 Monitoring & Logs

### View Application Logs

```bash
# Docker Compose logs
docker-compose logs -f teaser-site

# Or specific number of lines
docker-compose logs --tail=100 teaser-site
```

### View Deployment Poller Logs

```bash
# Systemd journal
sudo journalctl -u tanglement-deploy-poll -f

# Or log file
tail -f /var/log/tanglement/deployment.log
```

### Health Checks

```bash
# Check container health
docker inspect --format='{{.State.Health.Status}}' tanglement-teaser-site

# Manual health check
curl http://localhost:3000/api/health
```

### Monitoring Deployment Status

```bash
# View current deployment state
cat /var/lib/tanglement/deployment-state.json

# Check gist directly
curl -s https://gist.githubusercontent.com/tanglement-ai/YOUR_GIST_ID/raw/deployment.json | jq
```

---

## 🔧 Troubleshooting

### Container Won't Start

```bash
# Check container logs
docker-compose logs teaser-site

# Check container status
docker-compose ps

# Restart container
docker-compose restart teaser-site
```

### Deployment Poller Not Working

```bash
# Check service status
sudo systemctl status tanglement-deploy-poll

# View recent logs
sudo journalctl -u tanglement-deploy-poll -n 50

# Restart service
sudo systemctl restart tanglement-deploy-poll
```

### Image Pull Fails

```bash
# Verify GitHub token has packages:read permission
docker login ghcr.io -u your-username

# Manually pull image
docker pull ghcr.io/tanglement-ai/teaser-site:latest

# Check rate limits
curl -I https://ghcr.io/v2/
```

### Database Connection Issues

```bash
# Check PostgreSQL container
docker-compose ps postgres
docker-compose logs postgres

# Test database connection
docker-compose exec postgres psql -U tanglement -d tanglement -c "SELECT 1;"
```

### Port Already in Use

```bash
# Find process using port 3000
sudo lsof -i :3000

# Change port in docker-compose.yml
ports:
  - "3001:3000"  # Use port 3001 externally
```

---

## 🚀 Deployment Workflow

### Manual Deployment

```bash
# Pull latest image
docker-compose pull teaser-site

# Restart with new image
docker-compose up -d teaser-site

# Verify deployment
docker-compose ps
curl http://localhost:3000/api/health
```

### Automated Deployment (via GitHub Actions)

1. Push code to `main` branch
2. GitHub Actions builds and pushes image
3. GitHub Actions updates deployment gist
4. Deployment poller detects new version
5. Poller pulls image and restarts container
6. Poller updates gist with success status

### Rollback

```bash
# Stop current version
docker-compose stop teaser-site

# Use specific image tag
docker pull ghcr.io/tanglement-ai/teaser-site:main-abc123

# Update docker-compose.yml with specific tag
# Then restart
docker-compose up -d teaser-site
```

---

## 📝 Next Steps

1. Set up monitoring (Prometheus/Grafana)
2. Configure backups for PostgreSQL data
3. Set up log aggregation (Loki, ELK)
4. Configure auto-renewal for SSL certificates
5. Set up staging environment

---

**Questions or issues?** Check the [main documentation](../../../docs/spec/15-teaser-site/README.md) or open an issue.
