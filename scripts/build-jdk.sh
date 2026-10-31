#!/usr/bin/env bash
# Builds build/jdk, the java.home the JVM runs on: the Linux x64 JDK 25 class
# library in the exploded layout (modules/<module>/...) instead of a
# lib/modules jimage, so classes and resources are plain files.
set -euo pipefail

cd "$(dirname "$0")/.."
out=build/jdk
modules=${JDK_MODULES:-java.se,jdk.compiler,jdk.httpserver,jdk.jartool,jdk.security.jgss,jdk.unsupported,jdk.zipfs,jdk.localedata,jdk.internal.md,javaweb.tls}

# Builds from one pinned JDK release so every machine makes the same image.
# Renovate bumps the release.
release=25.0.5+8
cache=${XDG_CACHE_HOME:-$HOME/.cache}/java-web

# Prints the home of the Temurin JDK for a platform, downloading it on first use.
jdk_home() {
  local platform=$1 home=$cache/jdk-$release-$1
  if [ ! -d "$home" ]; then
    mkdir -p "$cache"
    local url=https://github.com/adoptium/temurin25-binaries/releases/download/jdk-${release/+/%2B}/OpenJDK25U-jdk_${platform}_hotspot_${release/+/_}.tar.gz
    local tgz=$cache/jdk-$release-$platform.tar.gz want got
    curl -fsSL -o "$tgz" "$url"
    want=$(curl -fsSL "$url.sha256.txt" | cut -d' ' -f1)
    got=$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz") | cut -d' ' -f1)
    if [ "$got" != "$want" ]; then
      rm -f "$tgz"
      echo "JDK download has sha256 $got, Temurin publishes $want" >&2
      exit 1
    fi
    rm -rf "$home.tmp"
    mkdir -p "$home.tmp"
    tar -xzf "$tgz" -C "$home.tmp" --strip-components 1
    rm "$tgz"
    mv "$home.tmp" "$home"
  fi
  [ -d "$home/Contents/Home" ] && home=$home/Contents/Home
  echo "$home"
}

# The host JDK is the reference VM the tests run, and supplies the tools.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) host=x64_linux ;;
  Linux-aarch64) host=aarch64_linux ;;
  Darwin-x86_64) host=x64_mac ;;
  Darwin-arm64) host=aarch64_mac ;;
  *) echo "no Temurin JDK for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
JAVA_HOME=$(jdk_home "$host")
mkdir -p build
ln -sfn "$JAVA_HOME" build/hotspot

# The image comes from the Linux x64 JDK on every host, since the natives are
# the Linux ones. Temurin ships no jmods, so jlink cannot link it: the modules
# are extracted from its lib/modules and selected by scripts/LinuxImage.java.
linux=$(jdk_home x64_linux)
src=build/jdk-src
rm -rf "$src" "$out"
mkdir -p "$src" "$out/modules"
"$JAVA_HOME/bin/jimage" extract --dir "$src" "$linux/lib/modules"

# javaweb.tls is java-web's own TLS pass-through provider (scripts/tls), built
# here and added as a module. The VM turns it on only when HTTPS goes through
# the browser.
"$JAVA_HOME/bin/javac" -d "$src/javaweb.tls" $(find scripts/tls -name '*.java')

"$JAVA_HOME/bin/java" scripts/LinuxImage.java "$linux" "$src" "$modules" "$out"
rm -rf "$src"

# Without the generated SystemModules classes the JDK finds its modules by
# reading module-info.class files from the exploded tree.
"$JAVA_HOME/bin/java" scripts/ExplodedModuleInfo.java "$out"/modules/*/module-info.class

# jrt: URLs read their resources through the jimage reader. Classes stay in
# modules/, so the image holds only the other resources. It is not named
# lib/modules, which would switch the JDK to image mode.
work=$(mktemp -d "$PWD/build/work.XXXXXX")
"$JAVA_HOME/bin/java" scripts/ResourceImage.java "$out/modules" "$work" "$out/lib/resources.jimage"
rm -rf "$work"

# The same provider list with JavaWebTLS first, for java.security.properties
sec=$out/conf/security
{
  echo "security.provider.1=JavaWebTLS"
  sed -n 's/^security\.provider\.\([0-9][0-9]*\)=\(.*\)/\1 \2/p' "$sec/java.security" |
    while read -r n provider; do echo "security.provider.$((n + 1))=$provider"; done
} > "$sec/java-web-proxy.security"

# The one font text drawing runs on (lib/fonts is where the JDK looks), from a
# pinned DejaVu release. A new release needs a new sha256 here.
font_release=2.37
font_sha256=fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7
font_home=$cache/dejavu-fonts-ttf-$font_release
if [ ! -d "$font_home" ]; then
  tgz=$cache/dejavu-fonts-ttf-$font_release.tar.bz2
  curl -fsSL -o "$tgz" "https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_${font_release//./_}/dejavu-fonts-ttf-$font_release.tar.bz2"
  got=$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz") | cut -d' ' -f1)
  if [ "$got" != "$font_sha256" ]; then
    rm -f "$tgz"
    echo "DejaVu download has sha256 $got, expected $font_sha256" >&2
    exit 1
  fi
  rm -rf "$font_home.tmp"
  mkdir -p "$font_home.tmp"
  tar -xjf "$tgz" -C "$font_home.tmp" --strip-components 1 "dejavu-fonts-ttf-$font_release/ttf/DejaVuSans.ttf" "dejavu-fonts-ttf-$font_release/LICENSE"
  rm "$tgz"
  mv "$font_home.tmp" "$font_home"
fi
mkdir -p "$out/lib/fonts"
cp "$font_home/ttf/DejaVuSans.ttf" "$out/lib/fonts/"
cp "$font_home/LICENSE" "$out/legal/java.desktop/dejavu-fonts.txt"

# module -> packages index, so the boot loader can find a class without probing.
(cd "$out/modules" && export LC_ALL=C && for m in *; do
  find "$m" -mindepth 2 -name '*.class' | sed 's|/[^/]*$||' | sort -u | sed "s|^$m/||;s|^|$m |"
done) > "$out/lib/packages.txt"

echo "built $out ($(du -sh "$out" | cut -f1)) with $modules from JDK $release"
