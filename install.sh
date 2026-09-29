#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="dnscrypt-indicator@local"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "==> Installing GNOME Extension: $EXT_UUID..."

# 1. Compile schema
echo "  [1/4] Compiling GSettings schema..."
glib-compile-schemas "$SCRIPT_DIR/schemas/"

# 2. Create target directory
echo "  [2/4] Syncing extension files to $TARGET_DIR..."
mkdir -p "$TARGET_DIR"

# 3. Copy extension files
cp -r "$SCRIPT_DIR/metadata.json" \
      "$SCRIPT_DIR/extension.js" \
      "$SCRIPT_DIR/prefs.js" \
      "$SCRIPT_DIR/stylesheet.css" \
      "$SCRIPT_DIR/schemas" \
      "$TARGET_DIR/"

echo "  [3/4] Enabling extension via gnome-extensions tool..."
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$EXT_UUID" || true
fi

echo "  [4/4] Done!"
echo ""
echo "==> Installation complete!"
echo "NOTE on Wayland (Fedora default): If this is the first time installing, you may need to log out and log back in (or restart GNOME Shell) so GNOME discovers the new extension."
echo "You can check status with: gnome-extensions info $EXT_UUID"
