#!/bin/bash

# PDF Presenter - App Starter
# This script launches the PDF Presenter application

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="PDF Presenter"

echo "=========================================="
echo "  Starting $APP_NAME..."
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if node_modules exists
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo -e "${BLUE}[INFO]${NC} Dependencies not found. Please run ./linux-install.sh first."
    exit 1
fi

# Get IP addresses for display
IP_ADDRESSES=$(hostname -I 2>/dev/null | tr ' ' '\n' | head -5 || echo "localhost")

echo "The app will be available at:"
echo -e "  - Local:    ${GREEN}http://localhost:3000${NC}"
for ip in $IP_ADDRESSES; do
    if [ ! -z "$ip" ]; then
        echo -e "  - Network:  ${GREEN}http://$ip:3000${NC}"
    fi
done
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

cd "$SCRIPT_DIR"
npm start
