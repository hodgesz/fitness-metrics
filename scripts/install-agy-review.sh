#!/usr/bin/env bash
set -euo pipefail
umask 077
# Inspect the pinned bootstrapper, but never execute its shell/auth setup handoff.
# Direct extraction pins the payload too; installer-only pinning follows mutable latest.
[[ $# == 1 && -n $1 && ! -e $1 && ! -L $1 ]] || { echo 'Usage: install-agy-review.sh NEW_DIRECTORY' >&2; exit 2; }
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    payload_path=linux-x64/cli_linux_x64.tar.gz
    archive_hash=6395837ac0e193dd3fe50f1228e1c4aea345ca99636d54404ab7e74397d4091c
    binary_hash=085f43e0d0628a8a8dabe1e547067818fa2c0adc86cfac98a3c4492918f455ef
    hash_command=(sha256sum)
    ;;
  Darwin/arm64)
    payload_path=darwin-arm/cli_mac_arm64.tar.gz
    archive_hash=4fed2474da314f109cf505f1325eb84307afcd586242e6b691f074fd1a73e6aa
    binary_hash=74935642426b5bb1fcf07a5555f847c478f4517dd002c72b9c98159cb773b932
    hash_command=(shasum -a 256)
    ;;
  Darwin/x86_64)
    payload_path=darwin-x64/cli_mac_x64.tar.gz
    archive_hash=a81f6a49d3fe1c07919ed332f2363f95109549fdd0195cbe8344d226edafd4e3
    binary_hash=fa85a90abded17bcd1b185bbd1d6b1b82065f093ad4700d4dbacd3be2433294c
    hash_command=(shasum -a 256)
    ;;
  *) echo 'Pinned Mac arm64/x64 or Linux x64 required' >&2; exit 1 ;;
esac
mkdir -- "$1"
destination=$(CDPATH='' cd -- "$1" && pwd)
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 120 --retry 2 https://antigravity.google/cli/install.sh -o "$staging/installer.sh"
installer_hash=$("${hash_command[@]}" "$staging/installer.sh" | cut -d ' ' -f 1)
if [ "$installer_hash" != 62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042 ]; then
  echo 'Official installer pin changed; no payload was downloaded or executed.' >&2
  exit 1
fi
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 180 --retry 2 "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.2-4835981233356800/$payload_path" -o "$staging/agy.tar.gz"
[[ $("${hash_command[@]}" "$staging/agy.tar.gz" | cut -d ' ' -f 1) == "$archive_hash" ]]
[[ $(tar -tzf "$staging/agy.tar.gz") == antigravity ]]
tar -xOf "$staging/agy.tar.gz" antigravity > "$destination/agy"
[[ $("${hash_command[@]}" "$destination/agy" | cut -d ' ' -f 1) == "$binary_hash" ]]
chmod 0555 "$destination/agy"
echo 'Verified Antigravity 1.4.2 payload; no installer, shell setup or model executed.'
