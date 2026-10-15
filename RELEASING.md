# 发布清单（RELEASING）—— GitHub-only

**只发 GitHub。** 这个插件是「上游行为」的补丁（内置 fetch 的 10s 硬超时、undici 8 的
`allowH2` 默认值），DSH 侧一旦修好就没有存在价值，所以不往 npm 发、不进插件市场 ——
免得留下一个需要长期维护的发行物。

- 仓库：`https://github.com/mqnu00/dsh-undici-timeout`（**你要建**，需要你的账号）
- 安装命令（给别人看的）：`dsh plugin --profile web add github:mqnu00/dsh-undici-timeout`
- 想换 owner：`grep -rl "mqnu00/dsh-undici-timeout" . | xargs sed -i 's#mqnu00/dsh-undici-timeout#<owner>/<repo>#g'`

---

## 1. 本地验收（已通过，改完代码再跑一遍）

```bash
cd ~/program/dsh/dsh-undici-timeout
npm test                          # 18/18 单测（node:test，零依赖）
npm run pack:check                # tarball 里到底装了什么
./scripts/trial-install.sh        # 试装：tarball 源
./scripts/trial-install.sh --git  # 试装：本地裸仓库 git+file:// 源（≈ github: 源，同一条 pnpm 路径）
```

推完仓库之后，再补一条**真实远端**的验证（这才是别人实际会跑的命令）：

```bash
./scripts/trial-install.sh --spec=github:mqnu00/dsh-undici-timeout
```

两个试装都做了市场/用户装插件时做的全套：临时 DSH_HOME → 出厂 web 模板组合 profile →
`dsh plugin --profile web add <源>` → `--dump-config` 确认组合里有 `id: undici-timeout` →
`--port 0` 真启动 → 请求 `/_dsh/undici-timeout` 确认插件上岗，最后打印
`🎉 试装验证通过`。**这一步过了，别人 `github:` 装就不会翻车。**

> 关键前提：本插件零 npm 依赖、无 `prepare` / `install` 构建脚本，所以 pnpm 不会弹
> `allowBuilds` 授权 —— git 安装路径最常卡人的就是这一步。

## 2. 建仓库并推送（你来做）

仓库**公开**即可；建议顺手加上 `dsh-plugin` topic（别人搜得到，且以后想上精选目录也需要）。
本地 git 仓库已经 init + 提交 + 打 tag 好了：

```bash
cd ~/program/dsh/dsh-undici-timeout
git remote add origin git@github.com:mqnu00/dsh-undici-timeout.git   # 或 https://
git push -u origin main
git push origin v0.1.1
```

## 3. 发 GitHub Release（可选，推荐）

`github:` 源本身就能装，Release 是给两类人用的：不想 clone 的、想钉住某个版本的
（市场/目录的 `tarball:` 字段也只认 GitHub Release 的 https `.tgz`）。

```bash
cd ~/program/dsh/dsh-undici-timeout
npm pack                                   # 产出 dsh-undici-timeout-0.1.1.tgz

# 有 gh CLI 且已登录：
gh release create v0.1.1 dsh-undici-timeout-0.1.1.tgz \
  --title "v0.1.1" --notes-file <(sed -n '1,40p' README.md)

# 没有 gh：网页版仓库 → Releases → Draft a new release → tag 选 v0.1.1
#         → 把 tgz 拖进 assets → 发布
```

装这个资产（等价于 npm 的那种一次性安装）：

```bash
dsh plugin --profile web add https://github.com/mqnu00/dsh-undici-timeout/releases/download/v0.1.1/dsh-undici-timeout-0.1.1.tgz
```

⚠️ 如果以后写成 `releases/latest/download/<名字>.tgz`，**资产名里不要带版本号** ——
`latest` 只在请求时解析，文件名是照字面取的，带版本会在下次发版时静默 404。

## 4. 把本机 profile 从 `file://` 直插换成正式包装（可选，建议）

现在 `~/.dsh/profiles/web/cordis.patch.yml` 里是开发期的 `file://...?v=5` 直插。
换成正式包装后，`?v=` 缓存、「改 name 不重挂」这些坑就都不用管了：

```bash
# ① 先摘掉 file:// 那条（整块 `- insert: - id: undici-timeout ...` 删掉），等 HMR 跑一轮
# ② 再装正式包
dsh plugin --profile web add github:mqnu00/dsh-undici-timeout
# ③ 重启 DSH
curl -s http://127.0.0.1:3080/_dsh/undici-timeout | python3 -m json.tool   # 确认还是那条路由
```

> ⚠️ 两条路**别同时存在**：包内 `cordis.patch.yml` 的 insert id 也是 `undici-timeout`，同 id 冲突。

## 下次改代码发版

```bash
# 1. 改 lib/ ，把 package.json 的 version 往上加一位（0.1.2）
npm test && ./scripts/trial-install.sh --git   # 2. 验
git add -A && git commit -m "..." && git tag -a v0.1.2 -m "v0.1.2"
git push && git push origin v0.1.2             # 3. 推
npm pack && gh release create v0.1.2 dsh-undici-timeout-0.1.2.tgz   # 4. 发
```

`github:.../dsh-undici-timeout` 不带 `#tag` 时跟默认分支走，所以别人下次 `dsh plugin update`
就会拿到新版本；钉了 tag 的人停在原地 —— 两种都要，别只发 tag 不推 main。

## 回滚

- 用户侧：`dsh plugin --profile web remove dsh-undici-timeout`（或删掉 profile 里那条 insert），
  重启即回到 Node 内置 fetch 的原样行为。
- 仓库侧：`git tag -d v0.1.1 && git push origin :refs/tags/v0.1.1`，Release 在网页上删。

---

## 附录：以后想发 npm / 上精选目录（现在不做，材料已备好）

- 收录条目：[`contrib/awesome-dsh-plugin/mqnu00__dsh-undici-timeout.yml`](contrib/awesome-dsh-plugin/mqnu00__dsh-undici-timeout.yml)
  （上游 `awesome-dsh-plugin/awesome-dsh-plugin` 一个插件一个 YAML，放
  `data/plugins/<owner>__<repo>.yml`；**别手工改那边 README**；仓库要满 1 天、要 `dsh-plugin` topic）
- npm：本机 `~/.npmrc` 指向 `registry.npmmirror.com`（镜像站不能发版），需要
  `npm login --registry=https://registry.npmjs.org`；包名 `dsh-undici-timeout` 目前**未被占用**。
  真要发的话，往 `package.json` 加回：

  ```json
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org" }
  ```
