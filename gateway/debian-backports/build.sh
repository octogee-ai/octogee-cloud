#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8
DEB_BUILD_OPTIONS="parallel=$(nproc)"
export DEB_BUILD_OPTIONS

sed 's/^Types: deb$/Types: deb-src/' /etc/apt/sources.list.d/debian.sources > /etc/apt/sources.list.d/debian-src.sources
apt-get update
apt-get install -y --no-install-recommends build-essential dpkg-dev patch

mkdir -p /out
build_package() (
    source_package=$1
    binary_package=$2
    cve=$3
    profiles=$4
    source_version=$(apt-cache policy "$binary_package" | awk '/Candidate:/ {print $2}')
    test -n "$source_version" && test "$source_version" != '(none)'

    apt-get build-dep -y --no-install-recommends --arch-only --build-profiles="$profiles" "$source_package=$source_version"
    work=$(mktemp -d)
    cd "$work"
    apt-get source --only-source "$source_package=$source_version"
    cd "$source_package"-*/
    patch --batch --forward --fuzz=0 -p1 < "/patches/$cve.patch"
    version="${source_version}+octogee1"
    printf '%s (%s) trixie; urgency=high\n\n  * Apply %s security backport.\n\n -- Octogee <security@octogee.com>  %s\n\n' \
        "$source_package" "$version" "$cve" "$(date -u -R -d "$(dpkg-parsechangelog -S Date)")" > debian/changelog.octogee
    cat debian/changelog >> debian/changelog.octogee
    mv debian/changelog.octogee debian/changelog
    dpkg-buildpackage --build=any -P"$profiles" --no-sign
    if [[ "$source_package" == libxml2 ]]; then
        printf '%s\n' '<!DOCTYPE status [<!ENTITY value "ready">]><status>&value;</status>' \
            | builddir/main/xmllint --nonet --noent - \
            | grep -Fx '<status>ready</status>'
    fi
    arch=$(dpkg --print-architecture)
    package="../${binary_package}_${version#*:}_${arch}.deb"
    test "$(dpkg-deb --field "$package" Version)" = "$version"
    install -m 0644 "$package" "/out/${binary_package}.deb"
    cd /
    rm -rf "$work"
)

build_package libxml2 libxml2 CVE-2026-6653 nopython
build_package openssh openssh-client CVE-2026-60002 noudeb,pkg.openssh.nognome
