#!/usr/bin/env bash
set -euo pipefail

uuid=quick-last-bluetooth@tech.puffyslippers.com
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_dir="$HOME/.local/share/gnome-shell/extensions/$uuid"
package="$script_dir/$uuid.shell-extension.zip"

gnome-extensions disable "$uuid" 2>/dev/null || true
install -d "$install_dir"
unzip -o "$package" -d "$install_dir"
glib-compile-schemas "$install_dir/schemas"
gnome-extensions enable "$uuid"
