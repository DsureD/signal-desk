# Signal Desk

Signal Desk 是一个轻量、适合个人部署的 ThingSpeak 数据仪表盘。它使用 Flask 提供后端接口和登录保护，使用 ECharts 展示实时数据，并通过 SQLite 保存数据源、字段名称和仪表盘卡片配置。

项目不会把 ThingSpeak 历史 feeds 写入本地数据库。打开或刷新图表时，历史数据会直接从 ThingSpeak API 获取；本地数据库只保存配置和必要的分享链接信息。

## 功能特性

- 通过密码保护仪表盘和管理 API。
- 管理多个 ThingSpeak Channel，并支持拖拽调整数据源顺序。
- 支持公开 Channel 和需要 Read API Key 的私有 Channel。
- 为每个数据源创建一个或多个数据卡片。
- 每张卡片可以选择一个或多个 field。
- 支持折线图、柱状图和面积图。
- 支持设置 Y 轴起始值、显示数据点和移动端 SVG 渲染。
- 支持当前值、最大值、最小值、平均值等数据摘要。
- 支持预设时间窗口、自定义时间范围和自动刷新。
- 支持全屏查看卡片，桌面端和移动端均可使用。
- 支持生成 6 位只读分享链接。
- 分享卡片可以配置多个可选时间窗口，访问者只能使用已配置的窗口。
- 支持 PWA、浏览器安装和 iOS 添加到主屏幕。
- 支持响应式布局、移动端侧边栏和基础离线缓存。


## 技术栈

- Python 3.10+
- Flask 3
- SQLite
- Requests
- ECharts 5
- 原生 HTML、CSS 和 JavaScript
- Gunicorn（生产环境，可选）

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/DsureD/signal-desk.git
cd signal-desk
```

### 2. 创建虚拟环境

Linux 或 macOS：

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 3. 安装依赖

```bash
pip install -r requirements.txt
```

### 4. 创建环境变量文件

Linux 或 macOS：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

至少修改以下两个配置：

```dotenv
FLASK_SECRET_KEY=replace-with-a-long-random-secret
DASHBOARD_PASSWORD=replace-with-your-private-password
```

然后启动：

```bash
python app.py
```

打开 <http://127.0.0.1:5000>，输入 `DASHBOARD_PASSWORD` 登录，再添加 ThingSpeak Channel。

公有 Channel 可以不填写 Read API Key；私有 Channel 必须填写对应的 Read API Key。API Key 只发送到服务器并保存在服务器端，不会出现在数据源列表接口响应中。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FLASK_SECRET_KEY` | `dev-only-change-me` | Flask Session 加密密钥，生产环境必须修改 |
| `DASHBOARD_PASSWORD` | 空 | 仪表盘登录密码，必须设置 |
| `DATABASE_PATH` | `./dashboard.db` | SQLite 数据库路径 |
| `THINGSPEAK_BASE_URL` | `https://api.thingspeak.com` | ThingSpeak API 地址，可用于自托管或测试环境 |
| `FLASK_HOST` | `127.0.0.1` | 直接运行时监听地址 |
| `FLASK_PORT` | `5000` | 直接运行时监听端口 |
| `FLASK_DEBUG` | `0` | 是否开启 Flask 调试模式，生产环境保持 `0` |
| `SESSION_COOKIE_SECURE` | `0` | HTTPS 部署时设为 `1` |

`FLASK_SECRET_KEY` 应使用不可预测的随机值。例如可以在服务器上执行：

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

## 数据和配置

应用启动时会自动创建 SQLite 数据库和必要的数据表。数据库包含以下几类信息：

- 数据源：名称、Channel ID、Read API Key、描述、启用状态和排序。
- 字段配置：Field 名称、单位、可见状态和 Y 轴配置。
- 卡片配置：标题、跨数据源 Field 列表、图表类型、Y 轴起始值、统计摘要和排序。
- 分享配置：是否启用、6 位分享 token、允许的时间窗口和自定义起止时间。

新建数据源时，应用会自动创建一张“实时趋势”卡片。首次创建时会包含 8 个 field，读取到数据后可以在编辑卡片窗口中重新选择实际有数据的 field。

历史数据不会被写入 SQLite。数据库文件默认是 `dashboard.db`，并已被 `.gitignore` 忽略。公开仓库前仍应确认没有把个人数据库、`.env`、Read API Key 或分享链接提交到 Git 历史中。

## 分享链接

在卡片编辑窗口中打开“开启分享链接”后，保存卡片即可生成类似下面的地址：

```text
https://example.com/share/Ab3xYz
```

分享页面具有以下行为：

- 不需要登录即可访问。
- 只展示卡片配置允许的 field 和时间窗口。
- 可以配置多个预设窗口，例如 `1H`、`24H`、`7D`。
- 自定义时间范围与预设窗口互斥。
- 分享页面不能自由选择未配置的时间范围。
- 关闭分享或删除卡片后，原地址立即失效。
- 分享 token 是 6 位大小写字母和数字组合，应当视为公开访问凭证，不要把它用于高敏感数据。

## 生产部署

推荐在 Linux 服务器上使用 Gunicorn，并通过 Nginx 或其他反向代理提供 HTTPS。

```bash
gunicorn --workers 2 --bind 127.0.0.1:5000 app:app
```

一个最小的 Nginx 反向代理示例：

```nginx
server {
    listen 443 ssl http2;
    server_name dashboard.example.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

生产环境建议：

1. 设置强随机的 `FLASK_SECRET_KEY` 和访问密码。
2. 将 `.env` 权限限制为应用运行用户可读。
3. 启用 HTTPS，并将 `SESSION_COOKIE_SECURE=1`。
4. 不要将 `dashboard.db`、`.env` 或任何 API Key 提交到公开仓库。
5. 根据服务器环境配置进程守护、日志轮转和数据库备份。

## PWA 说明

项目包含以下 PWA 资源：

- `manifest.webmanifest`：应用名称、简短名称、主题颜色和图标。
- `sw.js`：缓存应用壳资源，并缓存页面导航请求。
- `pwa.js`：注册 Service Worker。
- `apple-touch-icon.png`、`icon-192.png`、`icon-512.png`：安装和主屏幕图标。

API 请求不会被 Service Worker 缓存，因此图表数据仍会按当前时间窗口从服务器和 ThingSpeak 获取。使用 PWA 时建议确保首次访问能够连接网络，以便完成资源缓存。

## API 概览

除分享接口外，以下接口均需要先登录。请求体使用 JSON，成功或失败信息使用 JSON 返回。

### 数据源

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/sources` | 获取数据源列表、字段和卡片配置 |
| `POST` | `/api/sources` | 创建数据源 |
| `PUT` | `/api/sources/<source_id>` | 更新数据源 |
| `DELETE` | `/api/sources/<source_id>` | 删除数据源及其配置 |
| `PUT` | `/api/sources/order` | 保存数据源排序 |
| `PUT` | `/api/sources/<source_id>/fields` | 更新 Field 名称、单位等配置 |
| `GET` | `/api/sources/<source_id>/channel` | 获取 ThingSpeak Channel 元数据 |
| `GET` | `/api/sources/<source_id>/data` | 获取指定时间范围的 feeds |

### 数据卡片

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/sources/<source_id>/cards` | 获取卡片列表 |
| `POST` | `/api/sources/<source_id>/cards` | 创建卡片 |
| `PUT` | `/api/sources/<source_id>/cards/<card_id>` | 更新卡片 |
| `DELETE` | `/api/sources/<source_id>/cards/<card_id>` | 删除卡片 |

### 公开分享

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/share/<token>` | 打开只读分享页面 |
| `GET` | `/api/share/<token>` | 获取分享卡片和数据 |

分享数据接口可以通过 `window` 参数选择已配置的时间窗口：

```text
GET /api/share/Ab3xYz?window=24
```

数据源接口的常用查询参数：

- `results`：未指定时间范围时请求的数据点数量，服务端限制在 `1` 到 `8000` 之间。
- `start`：ISO 8601 起始时间。
- `end`：ISO 8601 结束时间。
- `last=1`：只请求最新一条数据，用于原始值模式的自动刷新增量更新。
- `aggregation`：`raw`（默认原始值）、`hour`（小时均值）、`day`（日均值）、`month`（自然月均值）。

原始值模式指定 `start` 或 `end` 时按时间边界请求 ThingSpeak，单次最多 8000 个数据点；浏览器的原始采样点不保证覆盖长时间范围的全部记录。

### 小时、日、月均值

主页面和分享页在时间范围下方提供独立的“展示粒度”切换；移动端四个按钮等宽排列。时间范围不随粒度切换改变，例如“最近 30 天 + 日均值”展示查询范围内每天的样本平均。默认仍为原始值，粒度选择仅作用于当前页面，不修改卡片或分享授权配置。

- 均值由后端读取完整原始记录后计算，不使用图表降采样点或浏览器增量缓存。
- 使用北京时间（UTC+8）的自然小时、自然日、自然月；每个字段按有效样本分别求算术平均，**不是时间加权平均**。
- 区间为 `[start, end)`：包含起点，不包含终点。首尾未覆盖完整时间段时标注“部分区间”，仅计算选定范围内的样本，不自动扩展查询权限。
- 空值、空白、非数值及无穷值不参与平均；真实的 `0` 保留。空段留空，均值折线不连接缺测段。
- 均值摘要为“末段均值、最高均值、最低均值、样本总均值”。最高/最低比较各段均值；总均值按各段有效样本数加权。末段没有有效数据时留空。
- 点击/悬停图表或展开“查看数据明细”，可查看实际统计区间、部分区间标记及各字段的有效样本数。
- 聚合自动刷新重新计算查询范围，避免只取最新一条导致漏算；加载时保留旧图并降低透明度，失败时保留旧图和旧口径，显示错误提示。

主接口聚合模式必须同时提供 `start` 和 `end`，不能与 `last=1` 同用：

```text
GET /api/sources/1/data?aggregation=day&start=2026-08-31T16:00:00Z&end=2026-09-30T16:00:00Z
GET /api/share/Ab3xYz?window=720&aggregation=day
```

分享接口仍只允许卡片配置的 `window`，客户端的 `start/end` 不会扩大授权范围。

为控制服务端负载，聚合范围最多 **366 天**，每次请求最多 **128 次上游读取、30 秒总等待、每源 50 万条原始记录**；分享卡片的多个源共用读取次数和时间预算。上游返回满 8000 条时继续拆分查询并去重；无法确认完整性、超过预算或超时时明确报错，不返回冒充完整结果的均值。遇到限制请缩小范围或减少卡片涉及的数据源。相同完整结果在单个进程内最多缓存 15 秒，最多保留 8 项。

部署时需要一并上传新增的 `aggregation.py` 和 `static/data-view.js`，并重启 Python 服务。无需数据库迁移或新增生产依赖。

## 项目结构

```text
.
├── app.py                    # Flask 应用、数据库初始化和 API
├── aggregation.py            # 完整取数、时间分桶和均值计算
├── requirements.txt          # Python 依赖
├── .env.example              # 环境变量示例
├── static/
│   ├── app.js                # 管理端交互和图表逻辑
│   ├── share.js              # 分享页面交互和图表逻辑
│   ├── data-view.js          # 共用统计口径、区间提示与明细表
│   ├── style.css             # 响应式样式
│   ├── manifest.webmanifest  # PWA Manifest
│   ├── sw.js                 # Service Worker
│   └── pwa.js                # PWA 注册脚本
└── templates/
    ├── login.html            # 登录页
    ├── index.html            # 管理端仪表盘
    └── share.html            # 公开分享页
```

## 开发说明

聚合功能的自动化测试使用模拟上游和独立临时数据库，不读取本机 `.env` 或访问真实 Channel：

```bash
python -B -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/*.test.js
```

可选的浏览器布局测试使用本机 Edge、模拟接口和真实前端脚本，覆盖 320 / 375 / 768 / 1440px，截图写入系统临时目录。需要支持内置 `fetch` 和 `WebSocket` 的 Node.js（建议 22+）；默认使用 Windows Edge 路径，其他环境用 `EDGE_PATH` 指定。测试会下载项目当前引用的公开 ECharts 文件，不运行 build：

```bash
node tests/browser-aggregation.cjs
```

部署后仍建议手动检查以下流程：

1. 登录、退出和错误密码提示。
2. 新建、编辑、排序和删除数据源。
3. 修改字段名称和单位。
4. 创建、编辑、删除卡片以及切换时间窗口。
5. 开启分享、访问分享页面、切换允许的分享窗口和关闭分享。
6. 桌面端、移动端、全屏和 PWA 安装体验。

## 安全与隐私

Signal Desk 面向个人部署，不是多用户 SaaS 系统。所有管理数据源和卡片的接口都依赖同一个登录密码；公开分享接口是设计上的例外。

请注意：

- Read API Key 会保存在服务器 SQLite 数据库中，请保护数据库文件和服务器权限。
- 分享链接持有者可以读取对应卡片允许的数据，不需要登录。
- 关闭分享后，服务端会拒绝原 token，但已经被访问者保存的数据无法被远程撤回。
- 生产环境必须使用 HTTPS，尤其是在公网部署时。
- 第三方 ECharts 和 Google Fonts 默认通过 CDN 加载，若部署环境不允许访问外部 CDN，需要改为本地静态资源。
