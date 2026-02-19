#!/bin/bash
set -e # Exit immediately if any command fails.

# --- 1. SYSTEM UPDATES & CORE DEPENDENCIES ---
# We keep this block clean of inline comments to avoid APT parsing errors.
apt-get update -y
apt-get upgrade -y
apt-get install -y \
    python3.11-venv \
    python3-pip \
    git \
    build-essential \
    curl \
    ca-certificates \
    gnupg

# --- 2. INSTALL UV (PYTHON PACKAGE MANAGER) ---
# uv is significantly faster and more reliable than standard pip.
curl -LsSf https://astral.sh/uv/install.sh | sh
# Ensure root can see uv
echo 'export PATH="/root/.cargo/bin:$PATH"' >> /root/.bashrc

# Setup for the primary 'ubuntu' user
sudo -u ubuntu -i <<'EOF'
curl -LsSf https://astral.sh/uv/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
EOF

# --- 3. INSTALL NODE.JS 20 & PM2 ---
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
apt-get update -y
apt-get install nodejs -y

# Install PM2 globally for process management.
npm install -g pm2

# --- 4. PRODUCTION HARDENING ---
# Enable PM2 to start on system boot for the ubuntu user.
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu

# Install log rotation to prevent app logs from filling up the disk over time.
sudo -u ubuntu -i <<'EOF'
pm2 install pm2-logrotate
EOF

# --- 5. DIRECTORY STRUCTURE & PERMISSIONS ---
# We pre-create these so that deployment and first-run have zero permission issues.
mkdir -p /home/ubuntu/sci-trace/kernel/artifacts
mkdir -p /home/ubuntu/sci-trace/host/logs
chown -R ubuntu:ubuntu /home/ubuntu/sci-trace
chmod -R 755 /home/ubuntu/sci-trace

# --- 6. PATH INJECTION ---
echo "PATH=\"$PATH:/home/ubuntu/.local/bin\"" > /etc/environment

# --- 7. APPLICATION BUILD UTILITY ---
# We create a helper script that the user (or deploy script) can call to
# refresh all dependencies and restart the bot in one go.
cat <<'EOF' > /home/ubuntu/setup-app.sh
#!/bin/bash
set -e
cd /home/ubuntu/sci-trace

echo "📦 Building Python Kernel..."
cd kernel
if [ ! -d ".venv" ]; then
    /home/ubuntu/.local/bin/uv venv
fi
source .venv/bin/activate
/home/ubuntu/.local/bin/uv pip install -r requirements.txt
cd ..

echo "📦 Building Node.js Host..."
cd host
npm install --production
cd ..

echo "🔄 Refreshing PM2 Processes..."
pm2 delete all || true
pm2 start ecosystem.config.js
pm2 save

echo "✅ App Setup Complete!"
EOF

chmod +x /home/ubuntu/setup-app.sh
chown ubuntu:ubuntu /home/ubuntu/setup-app.sh

echo "Sci-Trace Infrastructure Initialization Complete."
