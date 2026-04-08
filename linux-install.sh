#!/bin/bash

# PDF Presenter - Linux Installation Script
# This script installs Node.js if needed, installs dependencies, and launches the app

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="PDF Presenter"
NODE_VERSION="18"

echo "=========================================="
echo "  $APP_NAME - Linux Installer"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored messages
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Detect Linux distribution
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    elif [ -f /etc/debian_version ]; then
        echo "debian"
    elif [ -f /etc/redhat-release ]; then
        echo "rhel"
    else
        echo "unknown"
    fi
}

# Install Node.js based on distribution
install_node() {
    DISTRO=$(detect_distro)
    print_status "Detected distribution: $DISTRO"
    
    case "$DISTRO" in
        ubuntu|debian)
            print_status "Installing Node.js using apt..."
            curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        fedora)
            print_status "Installing Node.js using dnf..."
            sudo dnf install -y nodejs npm
            ;;
        rhel|centos|rocky|almalinux)
            print_status "Installing Node.js using yum..."
            curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | sudo bash -
            sudo yum install -y nodejs
            ;;
        arch|manjaro)
            print_status "Installing Node.js using pacman..."
            sudo pacman -Sy --noconfirm nodejs npm
            ;;
        opensuse*)
            print_status "Installing Node.js using zypper..."
            sudo zypper install -y nodejs npm
            ;;
        *)
            print_warning "Unknown distribution. Trying to install Node.js via Node Version Manager (nvm)..."
            if ! command_exists nvm; then
                curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
                export NVM_DIR="$HOME/.nvm"
                [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
            fi
            nvm install ${NODE_VERSION}
            nvm use ${NODE_VERSION}
            ;;
    esac
}

# Check Node.js installation
check_node() {
    if command_exists node; then
        NODE_CURRENT=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_CURRENT" -ge "16" ]; then
            print_success "Node.js $(node --version) is already installed"
            return 0
        else
            print_warning "Node.js version is too old ($(node --version)). Need >= 16"
            return 1
        fi
    else
        print_warning "Node.js is not installed"
        return 1
    fi
}

# Install dependencies
install_dependencies() {
    cd "$SCRIPT_DIR"
    
    if [ -f "package.json" ]; then
        if [ -d "node_modules" ]; then
            print_success "Dependencies already installed (node_modules found)"
        else
            print_status "Installing npm dependencies..."
            npm install
            print_success "Dependencies installed"
        fi
    else
        print_error "package.json not found. Are you in the correct directory?"
        exit 1
    fi
}

# Create uploads directory if it doesn't exist
setup_directories() {
    if [ ! -d "uploads" ]; then
        print_status "Creating uploads directory..."
        mkdir -p uploads
        touch uploads/.gitkeep
    fi
}

# Main installation flow
main() {
    # Check and install Node.js
    if ! check_node; then
        print_status "Installing Node.js..."
        install_node
        
        # Verify installation
        if ! command_exists node; then
            print_error "Node.js installation failed. Please install manually."
            exit 1
        fi
        print_success "Node.js $(node --version) installed"
    fi
    
    # Check npm
    if ! command_exists npm; then
        print_error "npm is not installed. Please install Node.js properly."
        exit 1
    fi
    print_success "npm $(npm --version) is ready"
    
    # Install dependencies
    install_dependencies
    
    # Setup directories
    setup_directories
    
    # Check if vendor files exist
    if [ ! -f "public/vendor/pdf.min.js" ]; then
        print_status "Downloading vendor files..."
        mkdir -p public/vendor
        curl -L -o public/vendor/pdf.min.js https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
        curl -L -o public/vendor/pdf.worker.min.js https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
        curl -L -o public/vendor/qrious.min.js https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js
        print_success "Vendor files downloaded"
    fi
    
    # Final message
    print_success "Installation complete!"
    echo ""
    echo "You can now start the application by running:"
    echo "  ./start-app.sh"
    echo ""
}

# Run main function
main
