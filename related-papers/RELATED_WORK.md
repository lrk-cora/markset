# MarkSet Related Papers（相关文献对照说明）

**MarkSet 流水线（对比时只盯「同一阶段」）**  
① 导入真实网页 → ② 圈选 / 画个人标记（定范围 + 表意图）→ ③ VL 认出标记与意图 → ④ 就地改 DOM（可撤回）→ ⑤ 导出。

**Related work 四条线**  
A. 圈选网页 / 笔迹定范围与命令　B. 个人符号习惯　C. 视觉指代与改页　D. 与大模型协作的直接操纵 / 可核对编辑 / 区域草图

【核心】= 重点对比　【次一级】= 有篇幅再写一两句

---

## 一、各文献：相关性 & 区别

### 【核心】1. MADCOW — 在网页上草图圈选

- **文件**：`01_MADCOW_JJAP_sketch_annotation.pdf`
- **文献**：Antico et al. *An Interactive Tool for Sketch-Based Annotation*. 2016.
- **同线同阶段**：线 A · 阶段②「在真实网页上圈选并落到 DOM」

**相关性**
- 同在真实网页上叠画布圈选，不是从零画站点草图。
- 同用自由闭合笔画（圆/框/路径）标出「指的是这块」。
- 同把圈选结果对应到 DOM，知道圈中了哪个节点/区域。

**区别（仍停在「圈选→DOM」这一阶段内比）**
- 圈选之后的去向不同：MADCOW 把选区留给**批注/讨论**；MarkSet 把同一阶段的选区继续交给后续「标记意图 → 改页面」。
- 选区本身不承载「要执行哪种编辑」的信息；MarkSet 在同一交互阶段还可叠加个人标记来表达操作。
- 一句话：同是网页圈选落 DOM；MADCOW 圈完用于批注，MarkSet 圈完用于驱动编辑。

---

### 【核心】2. cTed — 画选区映射到 HTML

- **文件**：`02_cTed_CHI2016_DOWNLOAD.txt`（ACM 需机构访问；按其中链接下载后可改名为 `02_cTed_CHI2016.pdf`）
- **文献**：Eichmann et al. *cTed…*. CHI EA 2016.
- **同线同阶段**：线 A · 阶段②「网页手势选区 → HTML/DOM」

**相关性**
- 同在已打开的网页上画选区，而不是用浏览器原生拖蓝条。
- 同把笔画智能映射到文本/列表/表格/图片等底层 HTML，尽量保住结构。
- 同解决「看得见的一块 → 对应页面结构里的哪些节点」。

**区别（只比「选区→HTML」这一步）**
- 映射完成后的用途不同：cTed 用于**摘录/复制出去**；MarkSet 用于在**原页结构上继续编辑**。
- 选区手势本身不表示编辑命令；MarkSet 在同一阶段还可把选区与标记命令绑在一起。
- 一句话：同是画选区对 HTML；cTed 为了拷走内容，MarkSet 为了在原页上改。

---

### 【核心】3. PapierCraft — 先定范围，再下笔迹命令

- **文件**：`03_PapierCraft_TOCHI2008.pdf`
- **文献**：Liao et al. *PapierCraft…*. TOCHI 2008.
- **同线同阶段**：线 A · 阶段②「scope（定范围）+ command（定操作）」

**相关性**
- 同把一次操作拆成：先圈选/下划线定**作用范围**，再画手势定**命令**。
- 同承认笔迹既能选内容，也能下指令（复制、粘贴、链接等）。
- 和 MarkSet「选区 + 标记/指令 → 执行」是同一条交互语法。

**区别（只比「范围+命令」这套语法）**
- 载体不同：纸+数字笔 vs 屏幕上的网页画布；但对比重点仍是命令结构，不是后面有没有 VL。
- 命令词表固定；MarkSet 在同一阶段允许用户自定义标记对应哪种操作。
- 作用对象是数字文档副本上的片段操作；MarkSet 的范围落在网页 DOM 模块上。
- 一句话：同是「先范围、后命令」；PapierCraft 用固定纸上手势，MarkSet 用网页上的个人标记习惯。

---

### 【次一级】4. Marking Menus — 笔迹触发命令

- **文件**：`04_MarkingMenus_Kurtenbach1993.pdf`（Kurtenbach 博士论文 PDF，内含 1993 Marking Menus 实证研究）
- **文献**：Kurtenbach et al. 1993.
- **同线同阶段**：线 A（偏理论）· 阶段②里「笔迹 = 命令」这一环

**相关性**
- 同把「画一下」视为触发命令的方式，而不必点菜单。
- 为线 A 提供「标记可以是命令」的经典依据。

**区别（只比「笔迹当命令」）**
- 标记空间是固定方向/形状的菜单加速器，不是开放的个人符号集。
- 不涉及「先圈网页范围再下命令」的两段式；MarkSet 的命令作用在已圈选的网页范围上。
- 篇幅紧时一句带过即可；个性化符号细节交给 SymbolDesign，两段式结构交给 PapierCraft。

---

### 【核心】5. SymbolDesign — 自定符号绑定命令

- **文件**：`05_SymbolDesign_UAIS2006.pdf`
- **文献**：Betke et al. *Symbol Design…*. UAIS 2006.
- **同线同阶段**：线 B · 阶段②「个人符号 → 操作含义」

**相关性**
- 同让用户**自己设计符号**并绑定到具体操作。
- 同强调符号要符合个人习惯、好画好认。
- 和 MarkSet「标记偏好」（符号对应什么编辑）同属个性化符号命令线。

**区别（只比「符号→命令」这一层）**
- 符号触发的是通用应用/输入命令；MarkSet 的符号绑定的是**针对已选网页内容**的编辑操作（并带作用范围）。
- 符号集服务的是辅助输入场景；MarkSet 服务的是网页内容编辑场景——仍是同一「符号语义」线上的对象不同。
- 一句话：都会自定义「符号=命令」；SymbolDesign 命令打在输入控制上，MarkSet 命令打在网页选区编辑上。

---

### 【次一级】6. Sikuli — 按视觉外观指到界面元素

- **文件**：`06_Sikuli_UIST2009_DOWNLOAD.txt`（公开镜像暂不可用；按其中 DOI 下载后可改名为 `06_Sikuli_UIST2009.pdf`）
- **文献**：Yeh et al. *Sikuli…*. UIST 2009.
- **同线同阶段**：线 C · 「视觉指代目标」

**相关性**
- 同用「长得像什么」来定位界面目标，而不是 CSS/XPath/控件 ID。
- 同假设：用户看得见的外观，就是指代依据。

**区别（只比「怎么用视觉指到目标」）**
- Sikuli 用**截图像素匹配**自动找目标；MarkSet 用**人画的圈选区域**指定目标。
- 找到目标后：Sikuli 交给脚本去点；MarkSet 交给同一流水线里的编辑。
- 一句话：同是视觉指代 UI；Sikuli 靠截图匹配，MarkSet 靠人圈选。

---

### 【核心】7. DocEdit-v2 — 多模态理解后改 HTML

- **文件**：`07_DocEdit-v2_EMNLP2024.pdf`
- **文献**：*DocEdit-v2…*. EMNLP 2024. arXiv:2410.16472
- **同线同阶段**：线 C · 阶段③–④「理解要改哪里 → 修改 HTML/CSS」

**相关性**
- 同用多模态模型参与「定位编辑区域 + 改页面结构」。
- 同最终落到 HTML/CSS 级修改，而不是只生成一段聊天文字。
- 和 MarkSet 的执行端（认清位置后改 DOM）同线。

**区别（只比「定位 + 改 HTML」这一段）**
- 定位主输入不同：DocEdit 主要靠**自然语言**让模型自己 grounding；MarkSet 在进入模型前，用户已用**圈选/标记**把范围和意图摆在图上。
- 因此同阶段内：一个是「语言指代 → 模型找位置 → 改 HTML」；一个是「空间标记 → 模型认标记 → 改 DOM」。
- 一句话：同会改 HTML；DocEdit 靠话指地方，MarkSet 靠圈和标记指地方。

---

### 【核心】8. Set-of-Mark (SoM) — 用可见标记帮模型定位

- **文件**：`08_Set-of-Mark.pdf`
- **文献**：Yang et al. *Set-of-Mark Prompting…*. 2023. arXiv:2310.11441
- **同线同阶段**：线 C · 阶段③「把可见标记交给 VL，稳定指代」

**相关性**
- 同证明：图像上有**看得见的标记**时，大模型更容易说清「指的是哪一块」。
- 同把「标记」当作多模态定位的关键线索。
- 直接对应 MarkSet「把圈画痕迹送给 VL 去认」这一阶段。

**区别（只比「标记如何服务 VL 定位」）**
- 标记来源不同：SoM 多为**系统自动叠标**（编号/框）；MarkSet 为**用户手动画标**。
- 标记功能不同：SoM 的标记主要当**指代锚点**；MarkSet 的标记在同一阶段既当指代，也常绑定**个人操作语义**。
- 一句话：都靠可见标记帮 VL 看懂指哪；SoM 是系统叠标做 grounding，MarkSet 是用户画标（兼命令）给模型认。

---

### 【次一级】9. TRISHUL — 区域与界面层级理解

- **文件**：`09_TRISHUL_GUI_region_2025.pdf`
- **文献**：*TRISHUL…*. 2025. arXiv:2502.08226
- **同线同阶段**：线 C · 「区域/层级理解」

**相关性**
- 同关心：屏幕上这一片属于哪个区域、和周围层级关系是什么。
- 与 MarkSet「圈稍偏也要对上正确模块/文字块」同属区域理解问题。

**区别（只比区域/层级理解怎么用）**
- TRISHUL 把区域层级理解供给 **GUI agent 自动操作**；MarkSet 把区域命中供给**人指定的编辑范围**。
- 同是区域理解能力，服务的闭环不同：代理连点 vs 人圈选后编辑。
- 仅在论文强调命中/层级时展开。

---

### 【次一级】10. Chickenfoot — 在渲染页上改网页

- **文件**：`10_Chickenfoot_UIST2005.pdf`
- **文献**：Bolin et al. *Automation and Customization of Rendered Web Pages*. UIST 2005.
- **同线同阶段**：线 C · 阶段④「改的是浏览器里已渲染的那一页，不是源站源码」

**相关性**
- 同在客户端对**已渲染网页**做定制/修改，不必改服务器源码。
- 和 MarkSet「导入页后本地改 DOM 再导出」同属渲染层/客户端改页。

**区别（只比「怎么改已渲染页」）**
- Chickenfoot 用**脚本 + 关键词**指到控件再改；MarkSet 用**圈选/标记**指定范围再改。
- 同是改渲染结果，入口交互不同：编程式 vs 画图式。
- related work 里一两句定位即可。

---

### 【核心】11. DirectGPT — 直接操纵对接大模型

- **文件**：`11_DirectGPT_CHI2024.pdf`
- **文献**：Masson et al. *DirectGPT…*. CHI 2024.
- **同线同阶段**：线 D · 「用空间/直接操纵指清对象，再交给大模型」

**相关性**
- 同认为纯聊天指代成本高，应用**点选、拖拽等直接操纵**把对象说清楚再送给模型。
- 同是「人在界面上指 → 模型干事」，降低语言歧义。

**区别（只比「人如何把对象交给模型」）**
- DirectGPT 把直接操纵主要翻译成 **prompt 拼装**（示范在文本/代码/矢量图等）；MarkSet 在同线上用**网页圈选 + 个人标记**作为给 VL 的输入。
- 同是 DM×模型；指代媒介与作用载体不同：通用对象上的 DM→prompt vs 网页上的圈画标记→认标执行。
- 一句话：都用直接操纵帮模型对准对象；DirectGPT 偏通用 DM 拼 prompt，MarkSet 偏网页圈画标记。

---

### 【核心】12. InkSync — 模型给出可接受/可拒绝的编辑

- **文件**：`12_InkSync_UIST2024.pdf`
- **文献**：Laban et al. *Beyond the Chat…*（InkSync）. UIST 2024.
- **同线同阶段**：线 D · 阶段④「模型参与编辑时，改动应可审查、可回退」

**相关性**
- 同反对模型一次性黑盒重写、用户说不清改了哪。
- 同主张改动以**可接受/可拒绝（或可撤回）的编辑动作**呈现，保留作者控制权。

**区别（只比「可核对的模型编辑」）**
- InkSync 的编辑单元是文本文档里的建议修改；MarkSet 的编辑单元是网页 DOM 上的一处圈选修改。
- 同线都是「可审查的编辑」；载体与触发方式不同：聊天/建议列表 vs 圈画驱动的页面编辑。
- 一句话：都要模型改动可控可回退；InkSync 管文本建议，MarkSet 管网页圈画修改。

---

### 【次一级】13. SketchFlex — 区域草图表达空间意图

- **文件**：`13_SketchFlex_CHI2025.pdf`
- **文献**：Lin et al. *SketchFlex…*. CHI 2025.
- **同线同阶段**：线 D · 「在区域里画画 = 表达空间意图」

**相关性**
- 同用**区域级草图**告诉系统「这里、大概这样」。
- 同把空间笔画当作意图载体，而不是只靠一句全局文字描述。

**区别（只比「区域草图承载什么意图」）**
- SketchFlex 的区域草图约束的是**文生图结果**；MarkSet 的区域圈画约束的是**网页上哪一块被编辑**。
- 同是区域笔画表意图；下游任务不同：出图 vs 改页。
- 系统若无「圈区生图」，此篇少写或不写。

---

## 二、Related Work 写法建议

按四条线写；**每一段只拿同线同阶段的文献比**，写完共性 → 同阶段差异 → 收束到 MarkSet。

1. **线 A（圈选 / 范围+命令）**：MADCOW、cTed、PapierCraft；一句 Marking Menus  
2. **线 B（个人符号）**：SymbolDesign  
3. **线 C（视觉指代与改页）**：SoM、DocEdit-v2；次要 Sikuli、Chickenfoot、TRISHUL  
4. **线 D（与模型协作）**：DirectGPT、InkSync；按需 SketchFlex  

**收束**：上列工作多只覆盖某一线某一阶段；MarkSet 要在真实网页上串起「个人标记习惯的圈选 → VL 认标 → 可撤回的 DOM 编辑 → 导出」。

---

## 三、外链备份

1. **MADCOW**：https://www.jstage.jst.go.jp/article/jjapcp/4/0/4_011604/_pdf/-char/en  
2. **cTed**：https://dl.acm.org/doi/pdf/10.1145/2851581.2892553  
3. **PapierCraft**：http://www.cs.umd.edu/hcil/trs/2008-16/2008-16.pdf ；https://dl.acm.org/doi/10.1145/1314683.1314686  
4. **Marking Menus**：https://billbuxton.com/MMUserLearn.html  
5. **SymbolDesign**：https://www.cs.bu.edu/fac/betke/papers/Betke-Gusyatin-Urinson-UAIS-2006.pdf  
6. **Sikuli**：https://doi.org/10.1145/1622176.1622213  
7. **DocEdit-v2**：https://arxiv.org/pdf/2410.16472  
8. **Set-of-Mark**：https://arxiv.org/pdf/2310.11441  
9. **TRISHUL**：https://arxiv.org/pdf/2502.08226  
10. **Chickenfoot**：http://www-ui.is.s.u-tokyo.ac.jp/%7Etakeo/course/2006/media/papers/chickenfoot_uist05.pdf  
11. **DirectGPT**：https://arxiv.org/pdf/2310.03691 ；https://damienmasson.com/pdfs/directgpt.pdf  
12. **InkSync**：https://arxiv.org/pdf/2309.15337  
13. **SketchFlex**：https://arxiv.org/pdf/2502.07556  
