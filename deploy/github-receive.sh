#!/usr/bin/env bash
# 安装为 SSH 专用密钥的 forced command；只接收指定提交的归档，不提供交互 shell。
set -euo pipefail
umask 077
ROOT="${NOWME_DEPLOY_DIR:-/opt/nowme}"
if [[ ! "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo '只接受 deploy <40 位提交号>' >&2
  exit 2
fi
SHA="${BASH_REMATCH[1]}"
mkdir -p "$ROOT/incoming" "$ROOT/releases"
exec 9>"$ROOT/.deploy.lock"
flock -w 2700 9
ARCHIVE=$(mktemp "$ROOT/incoming/$SHA.XXXXXX.tar.gz")
trap 'rm -f "$ARCHIVE"' EXIT
cat > "$ARCHIVE"
# git archive 只含受版本控制的文件，密钥和线上数据不在归档中。
STAGE=$(mktemp -d "$ROOT/releases/$SHA.XXXXXX")
tar --same-permissions --no-same-owner -xzf "$ARCHIVE" -C "$STAGE"
chmod 755 "$STAGE"
test -f "$STAGE/deploy/server-release.sh"
bash "$STAGE/deploy/server-release.sh" "$SHA" "$STAGE" "$ROOT"
