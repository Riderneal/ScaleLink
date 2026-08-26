#!/bin/bash
set -euxo pipefail

apt-get update -y
apt-get install -y redis-server

# Allow connections from the VNet (not just localhost) - restricted at the
# NSG level to the app subnet only, not exposed to the internet.
sed -i 's/^bind 127.0.0.1.*/bind 0.0.0.0/' /etc/redis/redis.conf
sed -i 's/^protected-mode yes/protected-mode no/' /etc/redis/redis.conf
systemctl restart redis-server
systemctl enable redis-server
