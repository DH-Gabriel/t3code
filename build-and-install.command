#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
[[ "$(uname -s)" == Darwin ]] || { echo 'This script requires macOS.'; exit 1; }
[[ "$(git branch --show-current)" == main ]] || { echo 'Switch this checkout to main first.'; exit 1; }
[[ -w /Applications ]] || { echo 'You need write access to /Applications.'; exit 1; }

if [[ -f "$HOME/.config/vite-plus/env" ]]; then
  source "$HOME/.config/vite-plus/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"
command -v vp >/dev/null || { echo 'Install Vite+ first.'; exit 1; }
node_version=$(node -p "require('./package.json').engines.node")
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo 'Unsupported Mac architecture.'; exit 1 ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/t3-build-install.XXXXXX")
install_stage=''
backup=''
destination=''
cleanup() {
  if [[ -n "$backup" && -d "$backup" && ! -e "$destination" ]]; then
    mv "$backup" "$destination"
  fi
  rm -rf "$work"
  if [[ -n "$install_stage" ]]; then
    rm -rf "$install_stage"
  fi
}
trap cleanup EXIT

echo 'Building main with your existing local configuration...'
vp env exec --node "$node_version" vp i --frozen-lockfile
vp env exec --node "$node_version" vp run dist:desktop:artifact \
  --platform mac --target zip --arch "$arch" --output-dir "$work/artifacts"

shopt -s nullglob
archives=("$work/artifacts/"*.zip)
[[ ${#archives[@]} -eq 1 ]] || { echo 'Expected exactly one app ZIP.'; exit 1; }
/usr/bin/ditto -x -k "${archives[0]}" "$work/unpacked"
apps=("$work/unpacked/"*.app)
[[ ${#apps[@]} -eq 1 ]] || { echo 'Expected exactly one app bundle.'; exit 1; }
app=${apps[0]}
name=$(basename "$app")
destination="/Applications/$name"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")

install_stage=$(mktemp -d /Applications/.t3-install.XXXXXX)
/usr/bin/ditto "$app" "$install_stage/$name"
echo "Build ready. Quit $name when your work is saved; installation will continue automatically."
while [[ -e "$destination/Contents/MacOS/$executable" ]] && \
  /usr/sbin/lsof -t "$destination/Contents/MacOS/$executable" >/dev/null 2>&1; do
  sleep 2
done

if [[ -e "$destination" ]]; then
  backup="$destination.backup-$(date +%Y%m%d-%H%M%S)-$$"
  mv "$destination" "$backup"
fi
mv "$install_stage/$name" "$destination"
echo "Installed $destination"
if [[ -n "$backup" ]]; then
  echo "Previous app saved at $backup"
fi
/usr/bin/open "$destination"
