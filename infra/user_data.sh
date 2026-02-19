#!/bin/bash
set -e

# Update and install basic dependencies
apt-get update -y
apt-get upgrade -y
apt-get install -y 
    python3.11-venv 
    python3-pip 
    git 
    build-essential 
    curl 
    ca-certificates 
    gnupg

# Install uv (Preferred Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh
# Ensure uv is in the path for ubuntu user
echo 'export PATH="/root/.cargo/bin:$PATH"' >> /root/.bashrc
sudo -u ubuntu -i <<'EOF'
curl -LsSf https://astral.sh/uv/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
EOF

# Install Node.js 20.x
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
NODE_MAJOR=20
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
apt-get update -y
apt-get install nodejs -y

# Install pm2 globally
npm install -g pm2

# Setup project directory
mkdir -p /home/ubuntu/sci-trace
chown ubuntu:ubuntu /home/ubuntu/sci-trace
chmod 755 /home/ubuntu/sci-trace

echo "Sci-Trace Infrastructure Initialization Complete."
