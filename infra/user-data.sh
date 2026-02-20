#!/bin/bash
# Sci-Trace Infrastructure Bootstrap

# --- 0. ENVIRONMENT INITIALIZATION ---
export HOME=/root
export USER=root
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export DEBIAN_FRONTEND=noninteractive

# --- 1. SYSTEM UPDATES & CORE DEPENDENCIES ---
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
curl -LsSf https://astral.sh/uv/install.sh | sh
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
npm install -g pm2

# --- 4. PRODUCTION HARDENING ---
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu
sudo -u ubuntu -i <<'EOF'
pm2 install pm2-logrotate
EOF

# --- 5. DIRECTORY STRUCTURE & PERMISSIONS ---
# We do this BEFORE OpenClaw to ensure directories are safe if OpenClaw setup hangs.
mkdir -p /home/ubuntu/sci-trace/kernel/artifacts
mkdir -p /home/ubuntu/sci-trace/host/logs
chown -R ubuntu:ubuntu /home/ubuntu/sci-trace
chmod -R 755 /home/ubuntu/sci-trace

# --- 6. SETUP .ENV PLACEHOLDER ---
cat <<'EOF' > /home/ubuntu/sci-trace/.env
# --- Host (Discord & OpenClaw) ---
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CLIENT_ID=your_discord_client_id_here
OPENCLAW_API_KEY=your_openclaw_api_key_here
DISCORD_GUILD_ID=your_discord_guild_id_here

# --- Kernel (LLM & Data) ---
OPENROUTER_API_KEY=your_openrouter_api_key_here
SEMANTIC_SCHOLAR_API_KEY=your_semantic_scholar_api_key_here
VERBOSE_REASONING=false
EOF
chown ubuntu:ubuntu /home/ubuntu/sci-trace/.env
chmod 600 /home/ubuntu/sci-trace/.env

# --- 7. APPLICATION BUILD UTILITY ---
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

    echo "🦞 Registering OpenClaw skills (AgentSkill format)..."
    # We point to the parent directory. OpenClaw scans subfolders for SKILL.md files.
    openclaw config set skills.load.extraDirs '["/home/ubuntu/sci-trace/host/skills"]' --json || true

    # Enable chatCompletions endpoint.
    openclaw config set gateway.http.endpoints.chatCompletions.enabled true || true

    openclaw gateway restart || true # Restart gateway for config to apply
else

    echo "⚠️ OpenClaw not found. Cannot enable chatCompletions endpoint or register skills automatically."
fi

echo "✅ App Setup Complete!"
EOF
chmod +x /home/ubuntu/setup-app.sh
chown ubuntu:ubuntu /home/ubuntu/setup-app.sh

# --- 8. INSTALL OPENCLAW AGENT (NON-INTERACTIVE) ---
# We run this last. We set CI=true to signal a non-interactive environment.
# We also use '|| true' because the binary installs fine, only the TTY setup crashes.
echo "Installing OpenClaw..."
CI=true HOME=/root curl -fsSL https://openclaw.ai/install.sh | bash || true

# Fix paths for both users
echo 'export PATH="/root/.openclaw/bin:$PATH"' >> /root/.bashrc
sudo -u ubuntu -i <<'EOF'
echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.bashrc
EOF

# Inject into global environment
echo "PATH=\"$PATH:/home/ubuntu/.local/bin:/home/ubuntu/.openclaw/bin\"" > /etc/environment

# --- 9. ACTIVATE OPENCLAW SERVICE ---
# Enable lingering so user services run without an active session.
loginctl enable-linger ubuntu

# Start and enable the gateway service for the ubuntu user.
# We use '|| true' because the service might not be fully registered
# until the first manual 'openclaw onboard' is run by the user.
sudo -u ubuntu -i <<'EOF'
systemctl --user daemon-reload
systemctl --user enable openclaw-gateway || true
systemctl --user start openclaw-gateway || true
EOF

echo "Sci-Trace Infrastructure Initialization Complete."
