#!/usr/bin/env bash
# dsh-undici-timeout —— 发布前的「试装验证」
#
# 从「本地这坨代码」到「别人 clone/下载下来能不能装」，中间只有一条路：
# 让 dsh plugin add 真的装一遍、真启动一次、再看插件有没有上岗。这个脚本就是干这个，
# 全在一个临时 DSH_HOME 里，不碰你正在用的 ~/.dsh。
#
# 两种源各验一遍（都在本地做，不需要网络和 GitHub）：
#   tarball（默认）   npm pack 出来的 tgz —— 等价于 GitHub Release 资产 / npm tarball
#   --git             本地裸仓库 git+file:// —— 等价于 `github:owner/repo` 源（同一条 pnpm 代码路径）
#
# 用法：
#   ./scripts/trial-install.sh                 # 打 tarball 试装
#   ./scripts/trial-install.sh --git           # 从本地裸仓库 git 源试装
#   ./scripts/trial-install.sh /path/x.tgz     # 试装指定 tarball
#   ./scripts/trial-install.sh --spec=github:mqnu00/dsh-undici-timeout
#                                              # 直接验真实远端（github: / Release URL / npm 名）
#   ./scripts/trial-install.sh --keep          # 保留临时目录便于排障
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="tarball"
KEEP=0
PKG=""
SPEC_OVERRIDE=""
for arg in "$@"; do
  case "$arg" in
    --git) MODE="git" ;;
    --keep) KEEP=1 ;;
    --spec=*) SPEC_OVERRIDE="${arg#--spec=}"; MODE="spec" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) PKG="$arg" ;;
  esac
done

TRIAL="${DSH_TRIAL_HOME:-$(mktemp -d /tmp/dsh-undici-trial-XXXXXX)}"
mkdir -p "$TRIAL"

echo "== 1/5 准备安装源（$MODE）=="
if [[ "$MODE" == "spec" ]]; then
  SPEC="$SPEC_OVERRIDE"
  echo "   源：$SPEC"
  echo "   （直接验真实远端：github:owner/repo、Release 资产 URL、npm 名都可以）"
elif [[ "$MODE" == "git" ]]; then
  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "   ⚠️ 工作区有未提交改动 —— git 源装到的是**已提交**的内容，先 commit 再验"
  fi
  REMOTE="${DSH_TRIAL_REMOTE:-${TRIAL}-remote.git}"
  rm -rf "$REMOTE"
  git init --bare -q "$REMOTE"
  git -C "$REMOTE" symbolic-ref HEAD refs/heads/main
  git -C "$ROOT" push -q "$REMOTE" HEAD:refs/heads/main
  git -C "$ROOT" tag -l | while read -r t; do git -C "$ROOT" push -q "$REMOTE" "refs/tags/$t" 2>/dev/null || true; done
  SPEC="git+file://$REMOTE"
  echo "   源：$SPEC"
  echo "   （等价于 dsh plugin --profile web add github:mqnu00/dsh-undici-timeout）"
else
  if [[ -z "$PKG" ]]; then
    PKG="$ROOT/$(cd "$ROOT" && npm pack --silent | tail -1)"
  fi
  [[ -f "$PKG" ]] || { echo "❌ 找不到 $PKG"; exit 1; }
  SPEC="$PKG"
  echo "   源：$SPEC"
fi

echo "== 2/5 临时 DSH_HOME：$TRIAL =="
echo "== 3/5 初始化出厂 web profile =="
DSH_HOME="$TRIAL" dsh --profile web --dump-config > "$TRIAL/base-dump.yml"
echo "   基线组合 $(wc -l < "$TRIAL/base-dump.yml") 行"

echo "== 4/5 dsh plugin --profile web add =="
DSH_HOME="$TRIAL" dsh plugin --profile web add "$SPEC"

echo "== 5/5 组合检查 + 真启动 + 状态路由 =="
DSH_HOME="$TRIAL" dsh --profile web --dump-config > "$TRIAL/dump.yml"
if ! grep -q 'id: undici-timeout' "$TRIAL/dump.yml"; then
  echo "❌ profile 组合里没有 undici-timeout 的 insert 行 —— dsh.bundle / cordis.patch.yml 没生效"
  exit 1
fi
echo "   ✅ 组合成功：$(grep -A1 'id: undici-timeout' "$TRIAL/dump.yml" | tail -1 | sed 's/^ *//')"

DSH_HOME="$TRIAL" timeout 75 dsh --profile web --port 0 > "$TRIAL/boot.log" 2>&1 &
BOOT_PID=$!
PORT=""
for _ in $(seq 70); do
  PORT="$(sed -n 's#.*dsh web: http://127\.0\.0\.1:\([0-9]*\).*#\1#p' "$TRIAL/boot.log" | head -1)"
  [[ -n "$PORT" ]] && break
  kill -0 "$BOOT_PID" 2>/dev/null || break
  sleep 1
done
if [[ -z "$PORT" ]]; then
  echo "❌ 没有等到启动就绪行（dsh web: http://127.0.0.1:<port>），日志尾部："
  tail -30 "$TRIAL/boot.log"
  kill "$BOOT_PID" 2>/dev/null || true
  exit 1
fi
echo "   ✅ 启动就绪：http://127.0.0.1:$PORT"

echo "   == 插件状态路由（插件是否真上岗）=="
if curl -s --max-time 8 "http://127.0.0.1:$PORT/_dsh/undici-timeout" | python3 -m json.tool; then
  echo "   ✅ 状态路由应答正常"
else
  echo "   ❌ 状态路由没有应答"
  tail -20 "$TRIAL/boot.log"
  kill "$BOOT_PID" 2>/dev/null || true
  exit 1
fi

kill "$BOOT_PID" 2>/dev/null || true
wait "$BOOT_PID" 2>/dev/null || true
if [[ "$KEEP" == "1" ]]; then
  echo "   （临时目录保留：$TRIAL）"
else
  rm -rf "$TRIAL"
  [[ "$MODE" == "git" ]] && rm -rf "${REMOTE:-/nonexistent}"
fi
echo "🎉 试装验证通过（源：$MODE）"
