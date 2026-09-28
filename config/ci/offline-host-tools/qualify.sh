#!/usr/bin/env bash
set -euo pipefail
bash /probe/install-offline.sh
cmp /var/lib/dpkg/status /inputs/results/installed-status
cd /inputs/supplement
sha256sum -c SHA256SUMS
apt-get -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=/tmp/orca-empty-sources -o Dir::State::lists=/tmp/orca-empty-lists --no-install-recommends -y install /inputs/supplement/*.deb
while IFS=$'\t' read -r name expected; do test "$(dpkg-query -W -f='${Version}' "$name")" = "$expected"; done < expected.tsv
while IFS=$'\t' read -r name expected; do test "$(dpkg-query -W -f='${Version}' "$name")" = "$expected"; done < /inputs/results/installed-before.tsv
ninja --version > /results/ninja.txt
perl -Mbigint -MGetopt::Long -e 'print "$^V\n"' > /results/perl.txt
nasm -v > /results/nasm.txt
git --version > /results/git.txt
unzip -v > /results/unzip.txt
ln -s clang /usr/lib/llvm-21/bin/clang-cl
/usr/lib/llvm-21/bin/clang-cl /c /Fo/results/clang-cl.obj /results/compiler/probe.c
llvm-readobj-21 --file-headers /results/clang-cl.obj > /results/clang-cl-header.txt
grep -F IMAGE_FILE_MACHINE_AMD64 /results/clang-cl-header.txt
dpkg-query -W > /results/installed-packages.txt
cp closure.json SHA256SUMS expected.tsv /results/
printf 'offline supplemental install and tool smoke checks passed\n' > /results/SUPPLEMENT-SUCCESS
