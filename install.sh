#!/bin/bash
set -euo pipefail

# Deck macOS Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/222dotcrypto/opdeck/main/install.sh | sh

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO="222dotcrypto/opdeck"
APP_NAME="opdeck"
INSTALL_PATH="/Applications/${APP_NAME}.app"

# Utility functions
log() {
    echo -e "${BLUE}→${NC} $1"
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1" >&2
}

info() {
    echo -e "${YELLOW}!${NC} $1"
}

# Cleanup function
cleanup() {
    if [ -n "${TEMP_DIR:-}" ] && [ -d "$TEMP_DIR" ]; then
        log "Cleaning up temporary files..."
        rm -rf "$TEMP_DIR"
    fi
    
    if [ -n "${MOUNT_POINT:-}" ] && [ -d "$MOUNT_POINT" ]; then
        log "Unmounting DMG..."
        hdiutil detach "$MOUNT_POINT" 2>/dev/null || true
    fi
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Check if running on macOS
if [ "$(uname)" != "Darwin" ]; then
    error "This installer only works on macOS"
    exit 1
fi

success "Detected macOS"

# Detect architecture
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    ARCH_PATTERN="aarch64|arm64"
    log "Detected Apple Silicon (ARM64)"
elif [ "$ARCH" = "x86_64" ]; then
    ARCH_PATTERN="x86_64|x64"
    log "Detected Intel (x86_64)"
else
    error "Unsupported architecture: $ARCH"
    exit 1
fi

# Check if curl is available
if ! command -v curl &> /dev/null; then
    error "curl is required but not installed"
    exit 1
fi

# Create temporary directory
TEMP_DIR=$(mktemp -d)
log "Using temporary directory: $TEMP_DIR"

# Fetch latest release information
log "Fetching latest release from github.com/$REPO..."
RELEASE_JSON="$TEMP_DIR/release.json"

if ! curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" -o "$RELEASE_JSON"; then
    error "Failed to fetch release information from GitHub"
    exit 1
fi

# Extract the version
VERSION=$(grep -o '"tag_name":[^,]*' "$RELEASE_JSON" | head -1 | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
    error "Could not determine version from release"
    exit 1
fi

log "Found version: $VERSION"

# Find the appropriate .dmg asset for the architecture
DMG_URL=""
while IFS= read -r line; do
    if echo "$line" | grep -qE "\.dmg\""; then
        # Extract URL from the line
        url=$(echo "$line" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4)
        if echo "$url" | grep -qiE "$ARCH_PATTERN"; then
            DMG_URL="$url"
            break
        fi
    fi
done < "$RELEASE_JSON"

# Fallback: if no architecture-specific match, try any .dmg
if [ -z "$DMG_URL" ]; then
    DMG_URL=$(grep -o '"browser_download_url": *"[^"]*\.dmg"' "$RELEASE_JSON" | head -1 | cut -d'"' -f4)
fi

if [ -z "$DMG_URL" ]; then
    error "Could not find .dmg file in release assets"
    exit 1
fi

DMG_FILENAME=$(basename "$DMG_URL")
log "Download URL: $DMG_URL"

# Download the DMG
DMG_PATH="$TEMP_DIR/$DMG_FILENAME"
log "Downloading ${DMG_FILENAME}..."

if ! curl -fsSL -o "$DMG_PATH" "$DMG_URL"; then
    error "Failed to download DMG from $DMG_URL"
    exit 1
fi

if [ ! -f "$DMG_PATH" ]; then
    error "DMG file was not downloaded"
    exit 1
fi

success "Downloaded ${DMG_FILENAME}"

# Mount the DMG
log "Mounting DMG..."
MOUNT_POINT="$TEMP_DIR/mnt"
mkdir -p "$MOUNT_POINT"

if ! hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -quiet; then
    error "Failed to mount DMG"
    exit 1
fi

success "DMG mounted"

# Find the app in the mount point
APP_SOURCE=""
for item in "$MOUNT_POINT"/*.app; do
    if [ -d "$item" ]; then
        APP_SOURCE="$item"
        break
    fi
done

if [ -z "$APP_SOURCE" ]; then
    error "No .app found in mounted DMG"
    exit 1
fi

log "Found app: $(basename "$APP_SOURCE")"

# Check if app already exists
if [ -d "$INSTALL_PATH" ]; then
    info "Existing $APP_NAME.app found at $INSTALL_PATH"
    log "Removing old version..."
    rm -rf "$INSTALL_PATH"
fi

# Copy app to Applications folder
log "Installing ${APP_NAME}.app to /Applications..."
if ! ditto "$APP_SOURCE" "$INSTALL_PATH"; then
    error "Failed to copy app to /Applications"
    exit 1
fi

success "Installed ${APP_NAME}.app to /Applications"

# Unmount the DMG
log "Unmounting DMG..."
sleep 1
if ! hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null; then
    info "DMG unmount delayed (will try again on cleanup)"
fi
MOUNT_POINT=""  # Clear to prevent duplicate unmount in trap

# Remove quarantine attribute (ad-hoc signed apps)
log "Removing quarantine attributes..."
if ! xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null; then
    info "Could not remove all quarantine attributes (may not be present)"
fi

# Final success message
echo ""
success "Installation complete!"
echo ""
echo "  ${GREEN}${APP_NAME} ${VERSION}${NC} is ready to use."
echo ""
echo "  To launch: open /Applications/${APP_NAME}.app"
echo "  Or:        open -a ${APP_NAME}"
echo ""
echo "  Repository: https://github.com/${REPO}"
echo ""
