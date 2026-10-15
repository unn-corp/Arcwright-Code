#!/usr/bin/env bash
# Runs the install, update, and recovery validations for one target and writes a receipt for each.
# Every check runs even if an earlier one failed, so the receipts record the whole truth; the exit
# status is non-zero if any check failed.
#
# usage: fork-release-receipts.sh <target> <candidate-dir> <predecessor-dir> <predecessor-digest> <receipts-dir>
set -uo pipefail

target="$1"
candidate="$2"
predecessor="$3"
predecessor_digest="$4"
receipts="$5"

status=0
for check in install update recovery; do
  command=(node scripts/fork-release.ts receipt
    --check "$check" --target "$target" --candidate "$candidate"
    --predecessor "$predecessor" --predecessor-digest "$predecessor_digest" --out "$receipts")
  if [[ "$target" == linux-x64 ]]; then
    /usr/local/bin/t3-ci-package-vm run -- "${command[@]}" || status=1
  else
    "${command[@]}" || status=1
  fi
done
exit "$status"
