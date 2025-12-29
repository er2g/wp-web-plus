#!/bin/bash

# WhatsApp Web Panel - Setup Script

echo "=========================================="
echo "   WhatsApp Web Panel - Setup Assistant   "
echo "=========================================="

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed."
    echo "Please install Node.js (v18 or higher) and try again."
    exit 1
fi

# Check for NPM
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed."
    exit 1
fi

echo "[1/4] Creating directory structure..."
mkdir -p logs
mkdir -p data
mkdir -p data/session
mkdir -p data/media
mkdir -p data/accounts

echo "[2/4] Installing dependencies..."
npm install

echo "[3/4] Configuring environment..."
if [ ! -f .env ]; then
    echo "Creating .env file from template..."
    cp .env.example .env

    # Generate random session secret
    RANDOM_SECRET=$(openssl rand -hex 32)

    # Determine OS for sed compatibility
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/your-random-session-secret-here/$RANDOM_SECRET/" .env
    else
        # Linux
        sed -i "s/your-random-session-secret-here/$RANDOM_SECRET/" .env
    fi

    echo "-------------------------------------------------------"
    echo "IMPORTANT: A default .env file has been created."
    echo "You MUST edit '.env' to set a secure SITE_PASSWORD."
    echo "-------------------------------------------------------"
else
    echo ".env file already exists. Skipping creation."
fi

echo "[4/4] Finalizing..."
chmod +x server.js

echo ""
echo "=========================================="
echo "       Setup Completed Successfully       "
echo "=========================================="
echo ""
echo "To start the application:"
echo "  npm start"
echo ""
echo "To run in background (requires pm2):"
echo "  npm install -g pm2"
echo "  pm2 start server.js --name whatsapp-panel"
echo ""
