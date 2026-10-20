#!/bin/sh
# Build tfm-mac-helper into <repo>/bin/ (where src/fs/platform.ts looks for
# it). macOS only; needs the Xcode command line tools (swiftc).
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$here/../../bin"
swiftc -O -o "$here/../../bin/tfm-mac-helper" "$here/tfm-mac-helper.swift"
echo "built $here/../../bin/tfm-mac-helper"
