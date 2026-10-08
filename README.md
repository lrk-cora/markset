# MarkSet

导入本地 HTML，在页面上圈画、做标记、写下要求，系统判断后改网页，导出去掉批注的 HTML。

圈中什么就改什么。每处改完旁边可撤回，直到导出。

## 克隆后运行（放好 Key 即可，无需 `.env`）

需要 Git、Node.js **22.21+（22 系列）或 24.5+**，推荐安装最新的 Node.js 24。旧的 Node.js 18 无法运行当前启动命令；代理参数的版本要求见 [Node.js 官方说明](https://nodejs.org/api/cli.html#--use-env-proxy)。首次安装依赖和调用模型需要联网。

### 1. 克隆项目

```bash
git clone https://github.com/lrk-cora/markset.git
cd markset
```

### 2. 放置私下提供的 Key 文件

在**克隆得到的 `markset` 项目根目录**创建 `.markset-private` 文件夹，把私下提供的 **`阿里.txt`** 放进去：

```text
markset/
├── package.json
├── vite.config.js
└── .markset-private/
    └── 阿里.txt          ← 放在这里，和 package.json 相隔一层
```

例如项目克隆到 `D:\Projects\markset`，Key 的完整路径就是 **`D:\Projects\markset\.markset-private\阿里.txt`**。路径随克隆位置变化，**不需要原开发者的 `D:\doctor\Key` 目录**。macOS/Linux 也使用项目内同一个相对路径 `.markset-private/阿里.txt`。

- Windows 可以在项目根目录运行 `New-Item -ItemType Directory -Force .markset-private`，再用文件管理器复制 Key 文件。
- 文件名必须是 `阿里.txt`，不是 `阿里.txt.txt`；建议开启“显示文件扩展名”。原样复制提供的文件即可，文本编码为 UTF-8，包含唯一一个百炼 API Key；不要把 Key 粘贴到源码或命令行。
- **默认地域是北京 `cn-beijing`**，适用于项目此前验证的北京 Key。Key 本身不能用来自动判断地域；若提供其他地域的 Key，必须同时说明地域，并按下方可选配置修改。不要跨地域混用。[百炼官方 Key 与地域说明](https://help.aliyun.com/zh/model-studio/get-api-key)
- **不需要复制 `.env.example`，也不需要手动设置开启开关**。新克隆的项目检测到这个文件后自动使用百炼官方接口；默认分析模型 `qwen3.8-flash`，生图/编辑 `qwen-image-3.0`（高质量档 `qwen-image-3.0-pro`）。这不是更改 Codex 的模型。

### 3. 安装并启动

```bash
npm ci
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。在运行命令的终端按 **Ctrl+C** 即可关闭；重新运行 `npm run dev` 即可启动。更换/新放置 Key 后需要重启。

没有 Key 时，页面仍可打开，模型状态会显示未配置，AI 功能不可用。放好文件只是“已配置”；右侧「模型状态」的快速检测可验证接口鉴权，不偷偷触发付费生图，实际分析/生图成功会单独记录。启动本身不调用付费模型。

### 可选：覆盖配置和常见问题

- **已有 `.env` 的老用户**：已有配置优先，不会覆盖个人密钥路径或强行打开 `MARKSET_ALLOW_MODEL_CALLS=0`。如果状态显示“模型调用已关闭”，把自己的 `.env` 中该项改为 `1`，再重启。新克隆不需要这一步。
- **其他地域或其他私有路径**：复制 `.env.example` 为 `.env`，明确设置 `MARKSET_BAILIAN_REGION`、`MARKSET_BAILIAN_KEY_FILE` 和 `MARKSET_ALLOW_MODEL_CALLS=1`。相对密钥路径从项目根目录解析；也支持绝对路径。当前支持北京 `cn-beijing`、新加坡 `ap-southeast-1`、美国东部 `us-east-1`；模型必须在对应地域可用，不会自动尝试其他地域或第三方接口。
- **鉴权/额度错误**：有效 Key 还需要相应模型权限、可用额度、允许当前网络/IP。此时按右侧真实检测结果排查，不是重新复制文件就一定能解决。
- **端口占用**：关闭自己之前启动的实例，或运行 `npm run dev -- --port 5174` 并访问终端显示的地址。
- **后端必须在运行**：`npm run preview` 或仅把 `dist/` 静态托管不能提供模型后端；本地完整使用请运行 `npm run dev`。

### 密钥安全

`.markset-private/` 和 `.env` 已被 Git 忽略，私有目录及配置的密钥文件被开发服务器禁止通过 HTTP 读取；Key 只由后端读取，不发给浏览器，也不打包进前端。**不要放到 `public/`、`src/`，不要 `git add -f`，不要把 Key 文件上传到 GitHub、论文材料或公开群聊。** 自定义位置也应放在仓库外或 `.markset-private/` 内，确保自行设置 Git 忽略。

默认仅监听本机 `127.0.0.1`，不要直接作为公网付费 API 服务部署。分享 Key 相当于分享调用额度，建议为使用者提供专用、限权 Key，并在百炼控制台设置预算/监控。

### 已验证的首次运行链路

2026-10-08，Windows / Node.js 24.19 的干净源码副本（没有 `.env`、旧依赖或缓存）已完成 `npm ci`、无 Key 启动、仅放置默认文件后启动和构建验证；中文/空格目录可用，私有文件 HTTP 访问被拒绝，前端输出不含测试密钥。自动配置及访问保护可用 `npm run test:setup` 复测（12 项）。

这些验证使用**测试占位 Key**，不读取分发的真实 Key，不调用付费模型，**不是对账户权限、余额、实时网络或模型效果的保证**。实际 Key 请在本机右侧「模型状态」中明确检测。

## 操作

1. **导入 HTML**
2. 画好后点 **开始判断**
3. **选择操作**
4. **导出网页**

| 快捷键 | 作用 |
|---|---|
| `Shift` + 圈 | 加选 |
| `Alt` + 圈 | 减选 |
| `Esc` | 取消当前笔画；再按清空 |
| `Backspace` | 擦上一笔 |
| `Ctrl` / `⌘` + `Z` | 撤回修改 |

顶栏「加选」「减选」同快捷键。偏好记错了，用 **管理偏好** 或顶栏 **标记偏好**。

画过的标记会记住（做什么、改整段还是只改画上记号的词）。换导入别的 HTML 仍然有效。有偏好时，点开始判断认出标记后会按偏好执行。

`samples/` 里有可直接导入的示例页。

## 论文与研究资料

- [UIST 论文工作稿](docs/research/uist-manuscript.md)
- [研究方案与文献地图](docs/research/README.md)
- [BibTeX 引用](related-papers/markset-hci-references.bib)

直接指代纠正、依赖方案失效和对照研究工具已实现最小版本，详见 [实现记录](docs/research/correction-implementation.md) 与 [实验运行说明](docs/research/study-runbook.md)。正式用户研究尚未开展，工程测试不能替代论文的实验结果。

## 相关文献

论文 related work 对照材料在 `related-papers/`（英文目录名便于 GitHub）：

- 对照说明：`related-papers/RELATED_WORK.md`
- PDF 按 `01`–`13` 编号；个别需机构下载的见同目录 `*_DOWNLOAD.txt`

## 功能

- **圈选**：不规则套索即可；加选 / 减选修范围
- **标记习惯**：同一符号可绑定高亮、加粗、删除、改色等；作用范围可选整个选区或画上标记的词
- **改文字**：改写、润色、高亮、下划线、加粗、删除
- **改模块**：改色、缩放、移动布局、配色方案、模块阴影或按笔迹形状的阴影
- **改图**：本地插入、AI 生图替换封面/配图（结合圈中区域和周围页面）
- **空白处插入**：先判断，再选 AI 生成、自己写或本地插入
- **撤回**：每处「已改 / 撤回」钉在改过的位置，滚动不丢，导出时去掉
- **导出**：得到可打开的 HTML，不含圈画和撤回标记

开始判断会把圈画截图交给视觉模型认标记和意图。本地几何只作提示和模型失败时的兜底。

## 仓库文件

| 路径 | 说明 |
|---|---|
| `src/` | 前端：圈画、判断、改网页 |
| `server/` | 本机接口：导入页面、转发模型 |
| `samples/` | 可导入的示例 HTML |
| `.env.example` | 模型配置模板 |
