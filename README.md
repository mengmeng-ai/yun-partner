# 允允的数字伙伴 — 桌面版（v0.2.0，项目名 yun-partner）

Clean-room 复刻：只参考 Aivy OS 对外公开的文档（官网、GitHub README / docs / 更新说明）里描述的功能和架构，自己从零写的代码。**没有反编译、没有解包、没有抄 Aivy OS 的代码、资源、品牌或激活逻辑。** 名字、图标、文案都是原创的。

## 已做好的（v0.2.0，全功能版）

- **Electron 壳**：主进程 + preload（`contextIsolation` 开、`nodeIntegration` 关，渲染进程只通过白名单 IPC 通信）。对话、IDE、员工队、语音、浏览器、记忆/Wiki、设置、灵魂 8 个面板。
- **模型层**：OpenAI 兼容 `/chat/completions` 客户端，流式输出、可停止、下一轮换模型即生效。默认 DeepSeek（`https://api.deepseek.com`，`deepseek-chat`），也可选 OpenAI、Ollama 本地（`http://127.0.0.1:11434`，`/api/chat`）、自定义 Base URL。设置里点“获取模型列表”可拉取可用模型。
- **灵魂**：`soul.md` 存在本地 userData，可在“灵魂”页编辑，保存后下次对话生效。默认伙伴叫“小月”，叫她允允/宝贝，短句口语。
- **记忆（语义找回）**：本地 JSON 存对话历史（最近 200 条）、画像、长期记忆、Wiki（Markdown 页，存在 `wiki/`）。召回已从关键词换成**本地 TF-IDF + 余弦相似度**——不用联网、不用付费 embedding、不用下载模型。说清楚：这是词法相似，不是真正的语义向量；同义词、换种说法可能找不着。Wiki 有交叉引用检查：孤立页、疑似矛盾（启发式，需人工核对）、90 天过期页。
- **工具（33 个，带确认）**：文件读/写/改/列目录/复制/移动/删除/追加/分页读/Diff/哈希/Glob/目录树，跑命令（Windows 用 PowerShell）、跑 Python，文档读（PDF/Word/Excel/PPT 提取文字）、文档写（Markdown/CSV/Excel），联网搜索（DuckDuckGo）、抓网页、全局搜索（正则 grep）、系统监控（CPU/内存/磁盘/进程）、撤回（改动记 7 天，48 小时内可见时间线）。所有工具**只能碰设置里的工作区**，超出工作区的路径会被拒绝。破坏性操作执行前会弹框问你，拒绝就不会执行。
- **IDE**：Monaco 编辑器 + 文件树，改动先看 Diff，确认才保存，放弃可回退；撤销时间线 200 条 / 48 小时，7 天内可撤回。预览台能看 Markdown、代码、文本、HTML（沙箱 iframe），PDF/Word/Excel/PPT 显示提取的文字，不是原版式。
- **语音（标准版）**：点按说话（Web Speech 识别）+ 系统语音朗读，ElevenLabs Key 可选填。**不是全双工**：说话时打断不了她，界面上写明了这一点。
- **员工队**：常驻 5 位——小探（查资料）、分析师（理思路）、阿工（动手改）、核对员（挑毛病）、监控员（盯变化），可再招 20 位自定义员工（每人最多 5 项技能）。大任务拆开并行派（每人同时 5 件，全队同时 10 件）。**安全阀是真的**：阿工改文件要先过核对员和你的批准才落地，命令默认不让员工自己跑。
- **MCP + 技能**：MCP 按需连接（stdio + Streamable HTTP，不开机自连，用时连、做完断），服务器在设置里登记。技能是本地文件夹（SKILL.md + 工具清单），贴 Git 地址安装，来路不明的会标“来路不明”。
- **定时任务**：本地提醒 + 任务板，到点会弹出来；关机期间错过的，下次解锁会告诉你（7 天内）。
- **电脑操作 + 内置浏览器**：Windows 上用 UIA 认窗口、按控件名点和打字，做完再读一遍核对；Linux 上会直接说“仅支持 Windows”。内置浏览器多标签，能导航。
- **自动更新**：接 GitHub Releases（仓库 `mengmeng-ai/yun-partner`），启动后约 10 秒检查一次，有新版先问你，点“下载更新”才下载，下载完点“重启安装”才装。不点什么都不做，不用每次自己重新下载。**更新只替换程序文件，你的数据不会丢**：设置（settings.json）、灵魂（soul.md）、长期记忆（memory.json）、聊天记录（history.json）和 Wiki 都存在本机 userData，不会因为更新被删掉。仓库还没建好 / 没联网时，只会温和提示去 GitHub Releases 手动下载，不会报错弹窗。
- **安全**：首次在设置里设主人密码（scrypt 存哈希，不存明文）。每次启动都要输密码解锁才能用工具；未解锁 = 纯聊天。默认不监听任何端口，数据只在本地。日志里会对疑似 Key/密码脱敏；API Key 只存在本地 `settings.json`，不要发给任何人、不要提交到 Git。

## Windows 安装步骤

便携版：下载 `允允的数字伙伴 0.2.0.exe`，双击直接运行，不用安装。SmartScreen 会弹（没买签名证书），点“更多信息”→“仍要运行”。

源码版前置：Windows 10/11 64 位，Node.js 22.19+（建议直接装 Node 24 LTS，见 https://nodejs.org）、Git、Python 3.12。

```powershell
# 把 yun-partner-v0.2.0.zip 解压到一个英文路径下，例如 D:\yun-partner
cd yun-partner
npm install
npm run dev        # 开发模式：Vite + Electron
```

第一次打开：
1. 去设置页选 DeepSeek，填 API Key（去 https://platform.deepseek.com/api_keys 创建，创建后只完整显示一次，当场复制存好），点“获取模型列表”选一个模型，保存。
2. 在设置里选一个工作区文件夹（建议新建空文件夹，别选桌面/文档）。
3. 在设置里设主人密码；以后每次打开都要输密码解锁。
4. 在“灵魂”页把名字、称呼改成你想要的，保存。

打包：

```powershell
npm run build      # tsc + vite build
npm run dist       # electron-builder 出安装包（Windows 上跑会出 NSIS 安装包）
```

## 还没做的 / 做不到的（说清楚）

- **全双工语音**：没做。现有语音是点按说话 + 朗读，打断、语气识别、主动开口播报都没做。
- **Python 持久解释器**：没做。现在每次跑 Python 是临时脚本，变量不跨调用。
- **语义向量**：记忆召回是 TF-IDF，不是 embedding 向量；同义词和换种说法可能找不着。
- **联网搜索**：DuckDuckGo 在沙箱里会被机器人验证挡（HTTP 202），代码里遇到会如实报错而不是假装没结果；她电脑上的网络下能不能用，要实测。
- **电脑操作**：只在 Windows 上能用，Linux 上是明确标出来的占位；UIA 脚本在她真机上也没跑过，要实测。
- **MCP**：stdio / HTTP 两种传输都写了，但没接过真实 MCP 服务器实测。
- **企业微信 / 多通道**：没做。
- **自动更新**：要等 `mengmeng-ai/yun-partner` 仓库建好、CI 发出第一个 Release 才能真正跑起来；现在会一直显示手动下载提示，这是设计好的降级，不是 bug。

## 已知限制 / 未知

- API Key 在本地 `settings.json` 是明文存的（Windows 上以后再接 DPAPI/系统钥匙串加密）。
- 0.2.0 在 Linux 上通过了 `typecheck` + `build` + 便携版打包；Windows 真机 GUI 只验证过 0.1.0 能打开聊天，0.2.0 的新功能（员工队、语音、电脑操作、自动更新）都要在她电脑上实测。
- Aivy OS 内部实现（打包器、主程序语言、向量库、激活校验）未知，也不去碰——本项目按 Electron + Node/Python 的公开常规做法自己实现。
