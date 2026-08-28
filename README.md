# MarkSet

商品介绍页上的跨模态选区：一次套索同时圈到说明文字和产品图里的一块，标上 `#T1` `#I2`，在编号旁下命令，按类型写回原处。

本目录可单独推到 GitHub。

## 第 1 周（当前）

已实现、不接模型：

- 演示商品页：旧品名「琥珀陶杯」、旧颜色「暖茶」、一句「附赠杯盖」、带杯盖和木桌边的图、未圈中的价格
- `Alt` 或「套索模式」拖套索；单击补选；`Shift` 再圈追加
- 字：字符区间 + 蓝条；两端小圆点可拖，缩短选区
- 图：套索外框当范围；「改背景」= 整图减去物体
- `#T1` `#I2`、勾选「将改」、`×` 去掉、`Esc` 清空
- 工具条：统一风格（主按钮）、改写、替换、删除；输入框示例「海盐杯，雾蓝」
- 有图才出加 / 减 / 色笔（第 3 周才干活）

## 本地运行

需要 Node.js 18+，不要 Python 虚拟环境。

```bash
cd markset
npm install
npm run dev
```

打开终端里的地址（默认 <http://localhost:5173>）。

## 一次配齐第 2、3 周的 API

密钥只放在 `markset/.env`，由本机 Vite 转发。**不要**写进前端、**不要**用 `VITE_` 前缀、**不要**写进 `.env.example`。

**默认不消耗额度。** 套索、改选区、检查接口、插入文字/图片都不打模型。要改写/改图必须同时满足：

1. `.env` 里 `MARKSET_ALLOW_MODEL_CALLS=1`，然后**重启** `npm run dev`
2. 页面勾选「允许调用云端模型」
3. 点按钮后的确认框选确定

关掉其中任一开关，请求到服务器也会被拒绝。纯「替换」或只删字（不改图）仍是本地操作，不用额度。

一把百炼 Key + 一把 fal Key 就覆盖四类调用：

| 周 | 作用 | `.env` 项 | 现在的模型名 |
|---|---|---|---|
| 2 | 改字 | `DASHSCOPE_REWRITE_MODEL` | `qwen3.6-flash` |
| 3 | 看图拆单 | `DASHSCOPE_PLANNER_MODEL` | `qwen3-vl-plus` |
| 2 | 按 mask 局部重画 | `FAL_INPAINT_MODEL` | `fal-ai/flux-pro/v1/fill` |
| 3 | 求轮廓 | `FAL_SAM_MODEL` | `fal-ai/sam2/image` |

1. **百炼**： [API-Key 管理](https://bailian.console.aliyun.com/?tab=model#/api-key) 创建密钥；模型广场开通 **文本生成 `qwen3.6-flash`** 和 **视觉理解 `qwen3-vl-plus`**。旧名 `qwen-plus` / `qwen-vl-max` 已下线。
2. **fal**： [API keys](https://fal.ai/dashboard/keys) 创建一把 Key，重画和轮廓共用。
3. `copy .env.example .env`，填 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`（控制台「OpenAI 兼容」那一行）、`FAL_KEY`。
4. 关掉再开 `npm run dev`，点 **检查接口**。应看到百炼、fal 已接入，以及「服务器禁止调用」（这是默认，省额度）。
5. 真要改写/改图时：`.env` 把 `MARKSET_ALLOW_MODEL_CALLS` 改为 `1`，重启，再勾页面上的「允许调用云端模型」。
6. **松手贴轮廓**（可选，默认关）：再勾「松手贴轮廓」。圈图松手会把套索外框交给 fal SAM，选区贴到物体；**减选仍用本地像素**。每圈一次消耗一次 fal 额度，调试圈选请不要打开。

本机转发：`POST /api/rewrite`、`/api/plan`、`/api/inpaint`、`/api/sam`。无双开开关注则一律 403，不会打到百炼/fal。

## 建议你先试的圈法

1. 圈「琥珀陶杯」+ 杯子 → 统一风格，框里写「海盐杯」（第 2 周才真改）
2. 圈「暖茶」+ 杯身，别圈桌子
3. 圈多了桌边时：拖蓝条缩短字；图不要点 ×，等第 3 周减笔，或先取消勾选
4. 只改正文：取消勾选 `#I2` 再点改写

## 之后

| 周 | 做什么 |
|---|---|
| 2 | 改字写回；按像素 mask 局部重画；两边成功才写入。默认不打模型 |
| 3 | 松手求轮廓；加减笔；规划拆单 |
| 4 | 圈内核对；对比对话框 vs 分工具 vs MarkSet |
