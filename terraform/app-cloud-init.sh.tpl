#!/bin/bash
set -euxo pipefail

# --- Docker install (Ubuntu 22.04) ---
apt-get update -y
apt-get install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# --- Pull the app code and run it ---
git clone ${github_repo_url} /opt/scalelink
cd /opt/scalelink

cat > .env << EOF
NODE_ENV=production
PORT=8080
REDIS_URL=redis://${redis_private_ip}:6379
INSTANCE_ID=${instance_id}
BASE_URL=http://${lb_public_ip}
RATE_LIMIT_WINDOW_SECONDS=${rate_limit_window_seconds}
RATE_LIMIT_MAX_REQUESTS=${rate_limit_max_requests}
EOF

docker build -t scalelink:latest .
docker run -d --name scalelink --restart unless-stopped \
  --env-file .env -p 8080:8080 scalelink:latest
