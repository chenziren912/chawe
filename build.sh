#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p build/classes
find src -name '*.java' -print > build/sources.txt
javac --release 17 -encoding UTF-8 -d build/classes @build/sources.txt
jar --create --file build/chawe.jar --main-class chawe.Main -C build/classes .
printf 'Built build/chawe.jar\n'
