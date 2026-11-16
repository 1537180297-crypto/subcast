# 部署 SubCast 共享字幕 API（myvps）

目标：systemd 独立 Node 服务（不用 Docker），监听私有回环端口 8787，经 Nginx 暴露在 `https://subcast.qiaomu.ai/api/`。遵循 qiaomu-vps-website-ops 约定（参考 rss.qiaomu.ai 的 systemd Node 服务）。

## 1. 服务器准备（一次性）

```bash
ssh myvps 'useradd --system --home /opt/qiaomu-apps/subcast-api --shell /usr/sbin/nologin subcast || true'
ssh myvps 'mkdir -p /opt/qiaomu-apps/subcast-api/data && chown -R subcast:subcast /opt/qiaomu-apps/subcast-api'
```

VPS 上是 Node v22.23.4（`/usr/bin/node`），内置 `node:sqlite` 无需额外参数即可用，**不需要 npm install**（零依赖）。

## 2. 同步代码

在本地仓库根目录执行：

```bash
rsync -az --delete --exclude data --exclude node_modules --exclude .git \
  server/ myvps:/opt/qiaomu-apps/subcast-api/
```

## 3. 环境文件

```bash
ssh myvps 'install -m 600 -o subcast -g subcast /dev/null /opt/qiaomu-apps/subcast-api/.env'
```

然后写入以下内容（`ADMIN_TOKEN` 生成一个随机长串，例如 `openssl rand -hex 32`）：

```
PORT=8787
HOST=127.0.0.1
DATA_DIR=/opt/qiaomu-apps/subcast-api/data
ADMIN_TOKEN=<随机长串>
```

## 4. systemd 服务

```bash
scp server/deploy/subcast-api.service myvps:/etc/systemd/system/subcast-api.service
ssh myvps 'systemctl daemon-reload && systemctl enable --now subcast-api && systemctl status subcast-api --no-pager | head -15'
```

日志：`ssh myvps 'journalctl -u subcast-api -f'`（每请求一行，无 IP）。

## 5. Nginx

把 `deploy/nginx-location.conf` 的 `location /api/` 片段加入 `/www/server/panel/vhost/nginx/subcast.qiaomu.ai.conf` 的 HTTPS server 块（若改了端口，同步改 `proxy_pass`）。如果该站点还没有 vhost，按 qiaomu-vps-website-ops 的标准流程建 vhost + DNS-only A 记录（指向 76.13.103.27）+ Certbot 证书。

```bash
ssh myvps 'nginx -t && nginx -s reload'
```

## 6. 验证

```bash
curl -s https://subcast.qiaomu.ai/api/health
# {"ok":true,"version":"0.1.0","transcripts":0}

curl -s 'https://subcast.qiaomu.ai/api/v1/transcripts?key=yt:dQw4w9WgXcQ'
# {"error":"not_found"}
```

也可以从本机跑站点检查：

```bash
python3 ~/.agents/skills/qiaomu-vps-website-ops/scripts/qiaomu_vps_site_check.py \
  --host myvps --domain subcast.qiaomu.ai --runtime systemd --service subcast-api
```

## 7. 备份（可选，建议）

每天快照 SQLite（gzip，保留 30 份在 `data/backups/`）：

```bash
ssh myvps 'echo "17 3 * * * subcast cd /opt/qiaomu-apps/subcast-api && /usr/bin/node --disable-warning=ExperimentalWarning src/backup.js" > /etc/cron.d/subcast-api-backup'
```

## 8. 更新流程

重复第 2 步 rsync，然后 `ssh myvps 'systemctl restart subcast-api'`。数据库 schema 向后兼容（`user_version` 迁移），重启即生效。

---

## Deploy notes (English)

systemd standalone Node service (no Docker) on 127.0.0.1:8787, exposed as `https://subcast.qiaomu.ai/api/` through an Nginx location. The VPS runs Node v22.23.4 at `/usr/bin/node`; `node:sqlite` works without flags and there are no npm dependencies, so no `npm install` is needed on the server. Steps: create the `subcast` system user, rsync `server/` to `/opt/qiaomu-apps/subcast-api/` (excluding `data`), write the `.env` file (PORT/HOST/DATA_DIR/ADMIN_TOKEN), install `subcast-api.service`, add the `location /api/` snippet to the subcast.qiaomu.ai vhost, `nginx -t && nginx -s reload`, then verify `/api/health`. Optional daily cron runs `src/backup.js` (gzipped VACUUM INTO snapshots, 30 kept). Updates: rsync + `systemctl restart subcast-api`.
