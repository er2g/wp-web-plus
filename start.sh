#!/bin/bash

# WhatsApp Web Panel - Start Script

if [ ! -d "node_modules" ]; then
    echo "Dependencies not found. Running setup..."
    ./setup.sh
fi

echo "Starting WhatsApp Web Panel..."
npm start
