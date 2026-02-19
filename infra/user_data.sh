#!/bin/bash
set -e # Exit immediately if any command fails.

# Update and install basic dependencies.
apt-get update -y # Refresh apt package index.
apt-get upgrade -y # Apply available package upgrades.
apt-get install -y \
    python3.11-venv \ # Python venv support for isolated environments.
    python3-pip \     # Python package installer.
    git \             # Source control for cloning repos.
    build-essential \ # Compiler toolchain for native builds.
    curl \            # HTTP client for downloads.
    ca-certificates \ # TLS certs for HTTPS validation.
    gnupg             # GPG for verifying repository keys.

# Install uv (preferred Python package manager).
curl -LsSf https://astral.sh/uv/install.sh | sh # Install for root (uses /root/.cargo/bin).
# Ensure uv is in the PATH for future root shells.
echo 'export PATH="/root/.cargo/bin:$PATH"' >> /root/.bashrc
# Install uv for the ubuntu user and update their PATH.
sudo -u ubuntu -i <<'EOF'
curl -LsSf https://astral.sh/uv/install.sh | sh # Install for ubuntu user.
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc # Persist PATH for ubuntu.
EOF

# Install Node.js 20.x.
mkdir -p /etc/apt/keyrings # Create a secure keyring directory for apt keys.
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg # Add NodeSource GPG key.
NODE_MAJOR=20 # Choose the major Node.js version.
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list # Add NodeSource repo.
apt-get update -y # Refresh apt index after adding NodeSource.
apt-get install nodejs -y # Install Node.js and npm.

# Install pm2 globally.
npm install -g pm2 # Process manager for Node.js apps.

# Setup project directory.
mkdir -p /home/ubuntu/sci-trace # Create app directory.
chown ubuntu:ubuntu /home/ubuntu/sci-trace # Assign ownership to ubuntu user.
chmod 755 /home/ubuntu/sci-trace # Set permissions (rwx for owner, rx for others).

echo "Sci-Trace Infrastructure Initialization Complete." # Log completion message.
