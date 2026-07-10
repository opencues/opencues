#!/usr/bin/env bash
# Cross-compile the OpenCues TSF spike DLL from WSL with mingw-w64.
# No Visual Studio / Windows toolchain required.
#
#   integrations/windows/native/tsf/build-tsf.sh
#
# Output: opencues-tsf.dll (x64) next to the source. Copy it to Windows and
# register with register-tsf.ps1 (self-elevating).
set -euo pipefail
cd "$(dirname "$0")"

CXX=x86_64-w64-mingw32-g++
command -v "$CXX" >/dev/null || { echo "✗ $CXX not found — sudo apt-get install g++-mingw-w64-x86-64"; exit 1; }

echo "▸ compiling opencues-tsf.dll (x64, static libgcc/libstdc++)…"
"$CXX" -shared -municode -O2 -s \
  -static-libgcc -static-libstdc++ \
  -o opencues-tsf.dll opencues-tsf.cpp opencues-tsf.def \
  -lole32 -loleaut32 -luuid -ladvapi32 -Wl,--kill-at

echo "  ✓ built: $(ls -la opencues-tsf.dll | awk '{print $5" bytes"}')"
echo "  next: copy to Windows + run register-tsf.ps1 (needs admin — one UAC prompt)"
