# Markset 论文文献地图与差异定位

资料范围截至 2026 年 10 月 7 日。重点是与 Markset 高度相似的交互机制，而不是简单累积引用数量。以下差异是研究定位建议，不能直接当作已经证实的原创性或性能优势。

## 必须优先阅读的近邻研究

| 文献 | 已有工作 | Markset 应进一步回答的问题 |
| --- | --- | --- |
| [DirectGPT](https://damienmasson.com/pdfs/directgpt.pdf) CHI 2024 | 将直接操作、对象指代、命令复用及撤销带入 LLM 交互。 | 原位笔迹相比普通对象选择，是否额外改善多区域、字符级和空白插入任务？不能把直接操作加 LLM 当作首创。 |
| [Code Shaping](https://www.wvisdomlab.com/papers/code-shaping.pdf) CHI 2025 | 在代码与输出上自由绘制标注，由 AI 解释为代码修改；研究用户如何表达及纠正意图。 | 非前端用户在渲染网页上表达局部修改时，有哪些不同的范围歧义和保留需求？不能把自由笔迹驱动修改本身作为新概念。 |
| [SketchGPT](https://orca.cardiff.ac.uk/id/eprint/181362/) UIST 2025 | 草图与语音覆盖系统界面，结合上下文推断意图，产生工具相关的可执行反馈并由人确认。 | 聚焦可编辑 HTML 快照，量化字符、模块及插入锚点的范围错误与越界修改。笔迹理解加工具执行加确认已经有很近的先例。 |
| [AnnotateGPT](https://vialab.github.io/AnnotateGPT/) CHI 2026 | 推断教师笔迹的批注目的，经用户确认后生成文档反馈。 | 从批注目的转向网页实际修改时，如何区分指代对象、最终效果与保留约束？不能把猜测笔迹意图或让用户确认作为独有机制。 |
| [Notational Animating](https://xinyu-shi.github.io/uploads/Notational_Animating_project_page/) CHI 2026 | 将有歧义、可组合的非正式符号转换为动画意图表示，并提供反馈和参数控制。 | 网页修改的意图表示如何连接字符范围、DOM 模块、空白位置及可逆事务？开放符号加结构化意图层已经被研究。 |
| [Misty](https://arxiv.org/html/2409.13900v3) CHI 2025 | 把示例截图或草图的选定方面混合进已有 UI 代码，并用语义差异支持细化。 | 针对非开发者的现有内容编辑，而非主要从示例混合原型；比较局部意图表达和保留约束，不声称首次编辑已有 UI。 |
| [InkSync](https://people.ischool.berkeley.edu/~hearst/papers/laban_uist_2024.pdf) UIST 2024 | 展示可接受或拒绝的文本修改，并支持生成内容的事实核验和审计。 | 网页布局与图片插入增加了哪些位置、遮挡、作用范围及回滚问题？可执行修改和用户决定权并非独有贡献。 |
| [Interaction Augmented Instruction](https://arxiv.org/abs/2510.26069) CHI 2026 | 形式化交互、文字提示与内容对象如何组成给生成式 AI 的指令。 | 用现有理论描述 Markset 的交互组合，再提供网页编辑领域的实证发现，不另称首次提出交互增强提示。 |

这几篇共同说明：最稳妥的主张不是“我们提出画一下就能让 AI 修改”，而是“我们研究用户如何在已有网页上协商修改范围，并检验自由笔迹相对于普通选择的额外价值”。

## 技术相关工作

| 文献 | 可支持的论述 | 不应外推的结论 |
| --- | --- | --- |
| [DocEdit v2](https://aclanthology.org/2024.emnlp-main.867/) EMNLP 2024 | 多模态请求定位、区域解释及文档结构编辑。 | 文档图像上的结果不证明 Markset 的 DOM 编辑成功率或用户效率。 |
| [SketchFlex](https://arxiv.org/abs/2502.07556) CHI 2025 | 区域草图与文字结合，控制生图的空间和语义关系。 | 生成的图片符合构图，不代表图片已正确插入网页。 |
| [Set of Mark](https://arxiv.org/abs/2310.11441) 2023 预印本 | 在图像区域上放置可指代的标记，帮助视觉定位。 | 区域编号既不是 Markset 首创，也不能保证网页编辑的语义或位置正确。 |
| [TRISHUL](https://arxiv.org/abs/2502.08226) 2025 预印本 | 屏幕层级、元素关系及视觉指代的建模。 | GUI 理解与操作定位，不等于重新设计页面并保留非目标内容。 |

技术评测应分别记录理解、目标定位、格式合法、执行效果及服务失败。不能用 HTTP 200、工具调用成功或模型自报置信度替代任务成功。

## 理论与设计依据

- [Bridging the Gulf of Envisioning](https://doi.org/10.1145/3613904.3642754)，CHI 2024，正式题名为 *Bridging the Gulf of Envisioning: Cognitive Challenges in Prompt Based Interactions with LLMs*。用于讨论目标、意图表达与结果评估之间的认知困难。arXiv 版本使用不同副标题，参考文献不要混写。

- [What It Wants Me To Say](https://lxieyang.github.io/assets/files/pubs/llmgam-chi-2023/llmgam-chi-2023.pdf)，CHI 2023。用于讨论终端用户如何把自己的想法转译成模型能够可靠处理的表达；其研究场景是电子表格，不是网页。

- [Guidelines for Human AI Interaction](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf)，CHI 2019。为能力提示、取消、纠正、不确定性与用户控制提供设计依据；不能当作 Markset 已经满足所有指南的证明。

- [PapierCraft](https://cogsci.ucsd.edu/~rik/courses/cogs1_w10/readings/liaoEtAl08.pdf)，TOCHI 2008。帮助交代笔迹命令与交互式纸张的历史。

- [cTed](https://doi.org/10.1145/2851581.2892553)，CHI 2016 Extended Abstracts。讨论网页内容选择机制；应准确标为扩展摘要集，而非 CHI 主会长文。

主实验可使用 [NASA TLX 官方量表与手册](https://www.nasa.gov/human-systems-integration-division/nasa-task-load-index-tlx/)评估工作负荷。它是测量工具，不是与 Markset 同类的系统论文。应事先固定版本、译文与计分方式，不将自编控制感题目称为标准量表。

## 相关工作章节的组织

建议写成四条论述，而不是按下载顺序逐篇介绍。

1. **在场指代与直接操作**：DirectGPT、IAI、cTed。说明为什么“这个、这里、旁边”需要连接用户看到的内容。

2. **非正式笔迹与 AI 意图理解**：Code Shaping、SketchGPT、AnnotateGPT、Notational Animating。说明视觉符号有歧义，不能硬编码为固定操作。

3. **已有内容的局部修改与用户控制**：Misty、InkSync、DocEdit v2。交代实际修改、保留约束、接受拒绝和可逆性。

4. **视觉定位与空间生成**：SoM、TRISHUL、SketchFlex。解释区域证据和空间关系，同时区分生图与网页插入。

在每条末尾写一个具体的未回答问题，例如：“自由笔迹相对于多区域选择，是否能降低关系性网页修改的指代成本，同时避免增加非目标内容变化？”不要把此前工作描述成完全不能理解意图或没有用户控制。

## 现有仓库资料的校正

当前仓库已有 13 份 PDF 和 RELATED_WORK.md。它们适合作为阅读起点，不是完整的最新文献覆盖。

- 编号 02 的 cTed 已有 PDF，不再只是待下载提示；其出版类型为 CHI 2016 Extended Abstracts。

- 编号 04 是 Gordon Kurtenbach 的 1993 年博士论文 *The Design and Evaluation of Marking Menus*，201 页，不应写成一篇 CHI 或 UIST 会议论文。

- 编号 06 的 Sikuli 已有 PDF。

- 编号 12 的 InkSync 本地版本为 36 页，作者提供的 UIST 2024 版本为 23 页；写作统一引用正式发表版本。

- SoM 和 TRISHUL 在这份文献包中按已核实的 arXiv 版本标为预印本，不凭文件名推断发表场所。

- 新补充的重点近邻是 Code Shaping、SketchGPT、Misty、AnnotateGPT、Notational Animating 和 IAI。未把它们加入运行时提示或模型历史。

本轮 bibliography 包含 15 条有正式 DOI 的论文、2 条明确标为预印本的论文及 1 条 NASA 官方量表资源。DOI 的题名、作者和年份与出版方登记的 Crossref 元数据交叉核对；论文机制以作者、机构、论文正文或正式出版记录为依据。

## 阅读与比较记录模板

每篇近邻论文记录以下信息，避免只读摘要后判断“与我们不同”。

- 用户是谁，任务是从零创作还是修改已有内容。

- 输入支持文字、点击、选择、笔迹、语音中的哪些组合。

- 视觉标记表达对象、动作、关系还是最终效果。

- 模型如何得到截图、结构和必要上下文。

- 用户何时确认，如何纠正、拒绝及撤销。

- 评估有哪些基线，测的是交互效率、效果、准确率还是偏好。

- 可以对照的具体任务；需要进一步核对而不能声称缺失的能力。

SketchGPT 的完整 PDF 在本轮访问中受到站点限制，因此对它仅使用机构记录与官方摘要可核实的机制，不作“没有范围验证”等实现层面的否定断言。这一边界尤其影响原创性判断。
