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

# 2. Sync codebase
# We exclude environments, secrets, and heavy artifacts to keep the sync fast.
# We include host/skills specifically to ensure OpenClaw discovery works.
echo "📦 Syncing core files..."
rsync -avz -e "ssh -i $KEY" \
    --exclude 'kernel/.venv' \
    --exclude 'kernel/lib' \
    --exclude 'host/node_modules' \
    --exclude 'kernel/artifacts/*' \
    --exclude 'host/logs/*' \
    --exclude '.git' \
    --exclude '.env' \
    --exclude '.agent' \
    --exclude '.context' \
    --exclude 'infra' \
    --exclude 'docs' \
    --exclude 'Makefile' \
    --exclude '*.out' \
    ./ $USER@$IP:$REMOTE_PATH

# 3. Remote Setup
# We hand off the heavy lifting to the 'setup-app.sh' script already present on the server.
# This ensures that deployment logic and server-init logic are perfectly synchronized.
echo "⚙️  Running remote application setup script..."
ssh -i $KEY $USER@$IP "bash /home/ubuntu/setup-app.sh"

echo "✅ Deployment complete!"
echo "👉 Note: Don't forget to manually upload your .env file to $REMOTE_PATH/.env"
echo "   You can do so securely using: scp -i $KEY .env $USER@$IP:$REMOTE_PATH/.env"
