# OMP 插件市场源（plugin-market）

OMP Desk 插件市场的官方索引仓库。桌面端扩展 Hub 的「市场」列表从这里拉取；
安装走 **逐文件 raw 下载 + sha256 校验**（`docs/plugin-market-design.md` §6–§9，
`backend/src/services/plugin-market-service.ts`）。

## 仓库布局

```
plugin-market/
├── index.json            ← 市场清单（脚本生成，勿手改）
├── README.md
├── scripts/
│   └── build-index.mjs   ← index.json 生成器（发布前必跑）
├── locus-git/            ← 一目录一插件；目录名 = index 里的 path
│   ├── manifest.json
│   ├── client.js
│   └── host.js
├── locus-usage/
│   └── …
└── locus-terminal/       ← 终端插件（真 PTY，@lydell/node-pty 由宿主 host.require 提供）
    └── …
```

**目录名与插件 id 是两回事**：`path` 白名单 `[A-Za-z0-9/_-]`（禁点号），
插件 id 必须带点（如 `com.locus.git`）。目录用无点短名，id 写在 manifest 里。

## 发布 / 更新流程

1. 新增或修改插件：改对应目录下的文件（**仅 UTF-8 文本**——安装管线按文本
   传输，二进制资源不走市场链）。
2. 递增该插件 `manifest.json` 的 `version`（更新比对的唯一依据）。
3. 重新生成清单：

   ```bash
   node scripts/build-index.mjs
   ```

4. `git add -A && git commit && git push`（raw 直读，无独立发布服务）。

桌面端扩展 Hub 点「刷新」即可看到新版本，安装即更新（同一条链，配置保留）。

## 约束（服务端硬校验，不满足会被拒）

- `index.json`：`schema: 1`；条目 `id` 必须与内联 `manifest.id` 一致（列表期校验）。
- `files[].name`：相对**插件目录**（如 `client.js`）——下载 URL 与安装落盘都按它拼。
- 单文件 ≤ 2MB；总包 ≤ 8MB（下载硬顶）；文件数有上限。
- `sha256` 为小写 hex；任何文件不符 ⇒ 整次安装中止，零落盘（全有或全无）。

## 指向本仓库

桌面端默认源走 **jsDelivr gh 镜像**（`https://cdn.jsdelivr.net/gh/LeeSeaside/plugin-market@main/index.json`）——
`raw.githubusercontent.com` 直连在国内间歇超时，且 Node 原生 fetch 不读系统代理；
jsDelivr 全球 CDN 直连稳定。代价是分支内容有约 12h 边缘缓存——**发布脚本已内置
purge 调用**（每次 build-index 推送后跑一遍即即时刷新）。

需要换回 raw（实时性好，适合海外网络）或指向镜像/自建静态源，用环境变量覆盖：

```
OMP_DESK_PLUGIN_INDEX_URL=https://raw.githubusercontent.com/LeeSeaside/plugin-market/main/index.json
```

发布完整流程：改包 → `node scripts/build-index.mjs` → `git add -A && git commit && git push`
→ **再跑一遍 `node scripts/build-index.mjs` 触发 purge**（或手动 curl purge URL）。
