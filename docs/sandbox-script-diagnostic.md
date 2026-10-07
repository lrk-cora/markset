# 刷新时的 sandbox 脚本报错

## 已确认

- 用户反馈红字在刷新时出现，不需要开启画笔。
- 编辑 iframe 从初始化起就使用 `sandbox="allow-same-origin"`，未指定 URL，因此控制台显示 `about:blank`。该位置只能确定被阻止执行的文档，不能确定脚本来源。
- 首次导入在服务端按字符串清理脚本；旧缓存恢复直接进入 `setHtml`。原先 `setHtml` 未对解析后的 DOM 再次清理。
- 项目 `src/`、`server/`、入口 HTML 未找到 `content_main.js`、`LanguageDetector` 或对应日志。这个文件名属于外部代码的线索，不能仅凭同屏相邻日志认定它造成了红字。

## 本次改动

`setHtml` 在 DOMParser 解析后、挂载前统一去除脚本、内联事件、可执行 URL 和嵌套执行容器；普通 HTML/CSS、图片、普通链接保留。首次导入和旧缓存恢复均走这个入口。

未添加 `allow-scripts`，未屏蔽控制台，未禁用任何扩展。此清理不能阻止页面挂载后由扩展或宿主注入的脚本，因此不声称红字已彻底消失。

## 2026-09-30：真实 Chrome 对照结果

用户确认关闭沉浸式翻译后仍出现这条红字。此前根据相邻的
`content_main.js` 日志推测翻译扩展，证据不足；不能继续当成根因。

在用户授权后，通过 Playwright 启动系统 Chrome 153.0.8010.53 的独立、
无扩展实例。没有读取或修改原浏览器资料、缓存、登录状态或扩展配置。
分别检查无界面模式和最小化窗口模式（后者也开启 DevTools）。

| 检查 | 实际结果 |
| --- | --- |
| 空缓存启动、刷新，创建 `about:blank` 沙箱 | 未产生该错误 |
| 11 个项目样例逐一写入测试 IndexedDB 后刷新恢复 | 未产生该错误 |
| 用户提供的 `00_训练全流程说明.html` 原文件检查 | 0 个 script、嵌套 frame/object/embed、内联事件属性 |
| 同一用户文件通过真实“导入网页”文件选择器及 API 导入，随后刷新 | 页面恢复正常，未产生该错误 |
| 导入页截图、删除标题并整组撤销 | 完成，未产生该错误 |
| 旧缓存含 HTML/SVG 脚本及事件属性，再挂载/修改/撤销 | 可执行标记被清理，DOM 修改和撤销正常 |
| 正向检测对照：仅在隔离测试页直接追加一个 script 节点 | 捕获与截图完全相同的原生 sandbox 红字，脚本未执行 |

这里监听的是 CDP `Log.entryAdded` 的原生安全日志，以及 `pageerror`，
不是只监听 `console.error`，也没有过滤/屏蔽用户报告的错误。
普通网络资源错误单独分类，不把它们当作 sandbox 脚本错误。
测试不调用模型和生图服务。

这不能证明用户原窗口没有问题。当前没有获得原窗口内触发脚本的 URL 或调用栈，
因此**具体触发源尚未定位，不能宣称已修复，也不能把来源确定为某个插件**。
已有实验证据不支持“静态 HTML 里自带脚本”或“DOM 编辑必须开放 allow-scripts”的解释。
下一步应在仍然报错的原窗口取证，而不是继续改 sandbox 权限或盲目清缓存。

## 可重复运行

```powershell
npm run test:browser
```

要同时测试一份本地用户 HTML（文件不会复制进仓库）：

```powershell
$env:MARKSET_DIAGNOSTIC_HTML = 'D:\path\to\reported-page.html'
npm run test:browser
```

浏览器测试代码：`tests/browser/sandbox.spec.js`。需要已安装系统 Chrome；
测试可复用 5173 的开发服务，否则自行启动 Vite。用户文件案例未配置路径时会明确跳过。
原生错误诊断附件保存在被 Git 忽略的 `test-results/`。

## 浏览器行为依据

Chromium 在沙箱脚本检查拒绝执行、且调用原因是 `kAboutToExecuteScript` 时输出此日志：
[LocalDOMWindow::CanExecuteScripts](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/frame/local_dom_window.cc)。
日志中的 `about:blank` 是被阻止执行的文档 URL，不是注入脚本来源。

## 独立问题：`/api/brush-intent` 失败却不提示

后续截图还包含 favicon 404 和模型接口 502。这些与原生 sandbox 日志不是同一条链路。
确认并修复的问题：

- `askModelToInterpret` 捕获失败后清空 `modelError`，因此错误 UI 永远不显示；
  原因只写入 debug 日志、降级 hint 又不在浮层显示。现在用独立 `analysisIssue`
  保留失败原因，不阻断本地操作，同时显示常驻提示、短通知和“重试 AI”。
- 旧 CSS 统一隐藏次要按钮，会隐藏重试入口。现在失败状态明确显示该按钮。
- 服务端把超时统一归为 502；超时计时器只覆盖响应头，不覆盖响应体读取。
  现在整次请求受同一截止时间约束，超时为 504，其他问题使用稳定错误码。
- 每个模型请求有 `X-Request-Id`；失败日志只记录编号、错误类别、状态和耗时，
  不记录密钥、网页、截图或用户输入。用户消息不直接回显网关错误页面。
- 降级发布可执行本地方案时，不再自动完成之前的 AI 提交；重试只是重新理解，
  不是自动执行。明确的本地改色/删除指令仍可直接确认执行。
- 已添加项目 favicon；去除意图请求中重复发送的一整份系统规则。

真实网关探测（使用合成内容，不上传用户文档）：文本请求约 10.1 秒返回 200；
带图请求曾在约 12 秒触发本地超时；后续独立探测约 10.3 秒返回 200。
这证明服务并非持续断连，也证明超时分类确实有问题；不能据此断言用户历史每次
502 都是同一个原因，或保证上游以后不再失败。没有提高线上超时配置、换模型或更换密钥。

回归测试：`tests/model-chat.test.js`、`tests/gateway-api.test.js`、
`tests/main-submission.test.js`、`tests/intent-submission.test.js`、
`tests/browser/analysis-errors.spec.js`。
