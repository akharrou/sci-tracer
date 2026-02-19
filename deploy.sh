#!/bin/bash
# Sci-Trace Deployment Script
# Usage: ./deploy.sh <EC2_PUBLIC_IP> <KEY_FILE_PATH>

set -e

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <EC2_PUBLIC_IP> <KEY_FILE_PATH>"
    exit 1
fi

IP=$1
KEY=$2
USER="ubuntu"
REMOTE_PATH="/home/ubuntu/sci-trace"

echo "🚀 Starting deployment to $IP..."

# 1. Check if key file exists
if [ ! -f "$KEY" ]; then
    echo "❌ Error: Key file not found at $KEY"
    exit 1
fi

# 2. Sync codebase (excluding local environments and secrets)
echo "📦 Syncing files..."
rsync -avz -e "ssh -i $KEY" \
    --exclude 'kernel/.venv' \
    --exclude 'host/node_modules' \
    --exclude '.git' \
    --exclude '.env' \
    --exclude 'kernel/artifacts/*' \
    --exclude 'host/logs/*' \
    ./ $USER@$IP:$REMOTE_PATH

# 3. Remote Setup
echo "⚙️  Configuring remote environment..."
ssh -i $KEY $USER@$IP << EOF
    cd $REMOTE_PATH
    
    # Kernel Setup
    echo "🐍 Setting up Python Kernel..."
    cd kernel
    if [ ! -d ".venv" ]; then
        uv venv
    fi
    source .venv/bin/activate
    uv pip install -r requirements.txt
    cd ..

    # Host Setup
    echo "📦 Setting up Node.js Host..."
    cd host
    npm install --production
    cd ..

    # Process Management
    echo "🔄 Restarting processes via PM2..."
    if command -v pm2 > /dev/null; then
        pm2 delete sci-trace-host || true
        pm2 start ecosystem.config.js
        pm2 save
    else
        echo "❌ PM2 not found. Please ensure infra setup completed successfully."
    fi
EOF

echo "✅ Deployment complete!"
echo "👉 Note: Don't forget to manually upload your .env file to $REMOTE_PATH/.env"
