# Awesome DSH plugin 收录条目 / registry entry

这个目录是**给上游仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR 用的投稿件**，
不在 npm 包里（`files` 没包含它）。

## 怎么用

1. 目标路径：`data/plugins/mqnu00__dsh-undici-timeout.yml`
   —— 上游一个插件一个 YAML 文件，文件名 = `<owner>__<repo>.yml`。
2. Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建分支，把
   [`mqnu00__dsh-undici-timeout.yml`](mqnu00__dsh-undici-timeout.yml)
   放进 `data/plugins/`，然后开 PR。
3. **不要手工编辑 README.md / README.zh.md** —— 那两个文件由
   `data/plugins/*.yml` 生成，合并后在 main 上自动重跑
   （想本地预览：`npm ci && node scripts/generate-readme.mjs`）。
4. 一个 PR 最多 3 条；CI 会检查：`dsh.bundle` 是否存在、仓库创建满 1 天、
   awesome-lint / 站点构建、双语一致性。
5. 合并后**不需要**做别的：网站自动重建，npm 映射（如果发了包）由 registry
   自动采集，条目里**不能手写 `npm:` 字段**（会被校验拒绝）。

## 收录的硬性前提（对回本仓库）

| 要求 | 本仓库状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ `{"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}` |
| 仓库根有对应的 `cordis.patch.yml` | ✅ |
| 真实可用代码（非占位/空壳） | ✅ `lib/index.js` 单文件约 700 行 + 18 个单测 + 4 个对照探针 |
| 仓库创建满 1 天 | ⚠️ 取决于你建仓库的时间，刚建就提会被 CI 打回（过一天再提即可） |
| 仓库打上 `dsh-plugin` topic | ⚠️ 建仓库后要在 Settings → Topics 里加上 |
| 描述属实、无营销词 | ✅ 条目里的每条能力都能在 `lib/index.js` 找到 |
