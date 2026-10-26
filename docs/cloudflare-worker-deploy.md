# 用 Cloudflare Worker + GitHub 部署 P1 / P0 / P2

这份配置把仓库变成一个 Worker：

- `/` → **P1 声浪应用**
- `/p0/` → **P0 能力探测**
- `/sensors/` → **P2.0 传感器探测**
- `/engine-worklet.js`、`/p0/worklet.js` → Worklet 备用文件
- `/404.html` → 静态 404

Worker 在 `worker.mjs` 里给所有资源加 `Cache-Control: no-store`，避免车机浏览器缓存旧版本。

仓库里已经包含：

```text
wrangler.jsonc              Worker / static assets 配置
worker.mjs                  ASSETS 绑定 + no-store 包装
scripts/assemble.mjs        把 P1、P0、P2 构建结果组装到 public/
package.json                build:all / preview / deploy 脚本
```

---

## 1. 本地先验证

```bash
npm install
npm run build:all
npx wrangler dev
```

打开：

- `http://localhost:8787/` → P1
- `http://localhost:8787/p0/` → P0
- `http://localhost:8787/sensors/` → P2.0 传感器探测

`build:all` 会：

1. 构建 P1 到 `p1/dist/`；
2. 构建 P0 到 `dist/`；
3. 构建 P2.0 到 `p2-probe/dist/`；
4. 组装 `public/`：
   - `public/index.html`（P1）
   - `public/engine-worklet.js`
   - `public/p0/index.html`（P0）
   - `public/p0/worklet.js`
   - `public/sensors/index.html`（P2.0 传感器探测）
   - `public/404.html`

`public/` 是构建产物，已加入 `.gitignore`；Cloudflare 构建时会重新生成。

---

## 2. 把仓库推到 GitHub

确认提交了：

- `wrangler.jsonc`
- `worker.mjs`
- `scripts/assemble.mjs`
- `package.json`
- `p1/` 和 `src/` / `build.mjs`

`public/` 不需要提交。

如果现有 Worker 已经连接了 GitHub，可以继续用同一个 Worker；否则新建一个。

### 先确认 Worker 名字

打开 `wrangler.jsonc`：

```jsonc
{
  "name": "nioengine",
  ...
}
```

- **新建 Worker**：保持 `nioengine`，或改成你想要的名字。
- **更新现有 Worker**：把 `name` 改成 Dashboard 里现有 Worker 的名字。

名字不一致时，`wrangler deploy` 可能新建第二个 Worker，而不是更新原来那个。

---

## 3. 在 Cloudflare Dashboard 连接 GitHub

路径（不同时间 UI 可能略有差异）：

**Workers & Pages → Create application → Workers → Connect to Git**

或者对现有 Worker：

**Worker → Settings → Build → Connect to Git**

配置：

| 项 | 值 |
|---|---|
| Repository | 你的 `nioengine` 仓库 |
| Production branch | `main`（或你的主分支） |
| Root directory | `/`（仓库根目录） |
| Build command | `npm run build:all` |
| Deploy command | `npx wrangler deploy` |
| Environment variable | `NODE_VERSION=22`（可选但推荐） |

保存后第一次构建会执行：

```text
npm install / npm ci
npm run build:all
npx wrangler deploy
```

如果自动安装依赖被跳过、提示找不到 `wrangler`，把 Deploy command 改成：

```bash
npx --yes wrangler deploy
```

或在 Build command 前加 `npm install`：

```bash
npm install && npm run build:all
```

如果构建日志提示没有 lockfile，也可以使用上面的 `npm install` 形式。

### Build watch paths（可选）

只在这些路径变化时触发构建：

```text
p1/**
p2-probe/**
src/**
scripts/**
build.mjs
p1/build.mjs
p2-probe/build.mjs
wrangler.jsonc
worker.mjs
package.json
```

不设置也可以，每次 push 都会构建。

---

## 4. Worker 配置说明

### `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "nioengine",
  "main": "worker.mjs",
  "compatibility_date": "2025-01-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": true,
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "404-page"
  }
}
```

关键点：

- `assets.directory` 指向 `public/`。
- `binding: "ASSETS"` 让 Worker 能 `env.ASSETS.fetch()`。
- `run_worker_first: true` 让请求先经过 `worker.mjs`，这样才能统一加 `no-store`。
- `html_handling: "auto-trailing-slash"` 支持 `/p0/` 这种目录首页。
- `not_found_handling: "404-page"` 使用 `public/404.html`。

### `worker.mjs`

```js
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    const body = response.status === 204 || response.status === 304 ? null : response.body;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
```

- 所有 HTML / JS 都不缓存，车机刷新就能拿到新版本。
- `Content-Type` 由 Cloudflare 静态资源服务器按扩展名给出，`.js` 是 `application/javascript`。
- 如果不需要 no-store，可以去掉这个包装，直接让 assets 服务；但 P1/P0 还在快速迭代，建议保留。

> 注意：`run_worker_first: true` 会让每个请求都走一次 Worker，会计入 Workers 请求额度。个人演示/少量车机使用足够；如果完全不想要 Worker 调用，可以改成纯 static assets（无 `main` / `binding`），但就失去统一的 no-store 头。

---

## 5. 绑定自定义域名

第一次部署先打开：

```text
https://<worker-name>.<your-subdomain>.workers.dev/
```

确认 P1、`/p0/` 和 `/sensors/` 都能打开后，再绑域名。

**Worker → Settings → Domains & Routes → Add → Custom Domain**

- 输入 `nioengine.com`；
- 如果域名已经托管在 Cloudflare，Cloudflare 会自动创建 DNS 记录并签发证书；
- 如果域名不在 Cloudflare，需要先把域名接入 Cloudflare（改 nameserver），再添加 Custom Domain；
- 原来指向旧服务器的根域名 A/AAAA/CNAME 记录需要删除或改由 Custom Domain 管理，避免冲突；
- 如果之前给旧 Worker 配过 `nioengine.com/*` Route，也要删除或调整。

可选：再加 `www.nioengine.com`，然后用 Cloudflare Redirect Rules 把 `www` 301 到 apex。

SSL/TLS 模式用 **Full (strict)** 即可；Workers 自定义域名不需要源站证书。

---

## 6. 上线后验证

```bash
curl -I https://nioengine.com/
curl -I https://nioengine.com/engine-worklet.js
curl -I https://nioengine.com/p0/
curl -I https://nioengine.com/p0/worklet.js
curl -I https://nioengine.com/sensors/
```

期望：

- `/` → 200，`content-type: text/html`
- `/engine-worklet.js` → 200，`content-type: application/javascript`
- `/p0/` → 200，P0 页面
- `/p0/worklet.js` → 200，`application/javascript`
- `/sensors/` → 200，P2.0 传感器探测
- 都带 `cache-control: no-store`

浏览器/车机检查：

1. `https://nioengine.com/` 打开 P1，启动发动机；
2. 右上角诊断：Worklet = Pass / blob，AudioContext = running；
3. `/p0/` 打开 P0，跑一次能力检测，确认 Worklet 仍通过；
4. `/sensors/` 打开 P2.0，允许位置/运动权限，确认 GPS 有定位、运动卡有数据；
5. 车机刷新后应拿到新版本，不应被旧缓存卡住。

---

## 7. 更新流程

```text
本地改代码
  → git push main
  → Cloudflare Workers Builds 自动 npm run build:all
  → npx wrangler deploy
  → 新版本上线
```

- 非 `main` 分支会生成 Preview URL（如果启用了 preview builds），可以先在预览里验收。
- 因为 Worker 设了 `no-store`，通常不需要手动清缓存；如果仍看到旧页面，检查是否命中了旧 Worker / 旧域名 / 浏览器强缓存。
- 回滚：Cloudflare Worker → Deployments，选择上一个版本重新部署；或在 GitHub revert 后 push。

---

## 8. 常见问题

### 构建成功但 `/p0/` 404

- 确认 `public/p0/index.html` 存在；
- 确认 `assets.directory` 是 `./public`；
- 确认 `html_handling` 是 `auto-trailing-slash`；
- 访问 `/p0/`（带斜杠），不要只访问 `/p0`。

### `/engine-worklet.js` 404 或 MIME 不对

- 确认 `public/engine-worklet.js` 被组装；
- 确认 Worker 不是只部署了 HTML；
- Cloudflare 静态资源会按 `.js` 设置 `application/javascript`；如果前面还有别的代理/Worker 改写了响应，检查链路。

### 部署到了另一个 Worker

`wrangler.jsonc` 的 `name` 和 Dashboard 里的 Worker 名字不一致。改成现有名字，或把自定义域名切到新 Worker。

如果仓库里已经有旧的 `wrangler.toml`，请删除它，只保留 `wrangler.jsonc`；Wrangler 同时存在两个配置时容易读错。

### 域名打不开 / 证书一直 pending

- 域名是否已接入 Cloudflare（nameserver 生效）；
- 是否有旧 A/AAAA/CNAME 记录占用 apex；
- 是否还有旧 Worker Route；
- 等 Cloudflare 证书签发完成。

### 页面还是旧版本

- 确认 `worker.mjs` 的 `no-store` 生效：`curl -I` 看响应头；
- 确认访问的是新 Worker 的域名，不是旧服务器；
- Cloudflare Dashboard → Caching → Purge Everything（一般不需要）；
- 车机浏览器彻底关闭再开。

### 构建日志里 `wrangler: not found`

把 Deploy command 改成：

```bash
npx --yes wrangler deploy
```

或 Build command：

```bash
npm install && npm run build:all
```

### 私有仓库拉取失败

在 Cloudflare 的 GitHub App 授权里，把该仓库加入可访问列表。

---

## 9. 只部署 P1 / 只部署 P0 / P2

当前默认是：

- P1 在 `/`
- P0 在 `/p0/`
- P2.0 在 `/sensors/`

如果只想部署 P1：

- 修改 `scripts/assemble.mjs`，去掉 P0/P2 的 copy；
- 或只上传 `p1/dist/index.html` + `p1/dist/engine-worklet.js` 到 static assets 目录。

如果想把 P0 放根、P1 放 `/p1/`：

- 交换 `assemble.mjs` 里的 `index.html` 和 `/p1/index.html` 路径；
- P1 的 `engine-worklet.js` 要放在 `/p1/engine-worklet.js`；
- P1 内部使用相对路径，放到子目录也能工作。

---

## 参考

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers Builds / CI-CD configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
