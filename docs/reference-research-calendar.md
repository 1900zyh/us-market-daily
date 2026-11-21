# GitHub 架构调研：行情日报、事件日历与 LLM 解释层

调研日期：2026-11-21，北京时间。此文件记录源码层面的设计参考，不表示已验证上游盈利能力，也不把上游 README 的宣传表述视为测试结论。GitHub REST API 当次遇到公共 IP 限流；仓库 HEAD 通过 `git ls-remote` 核验，以下关键源码已按提交哈希直接读取并确认 HTTP 200。

## 1. TradingAgents

- 仓库：https://github.com/TauricResearch/TradingAgents
- 核验 HEAD：`9fa1196fffbcfd9de5146d2dd2869df84ab99838`。
- README：https://github.com/TauricResearch/TradingAgents/blob/9fa1196fffbcfd9de5146d2dd2869df84ab99838/README.md
- 调度源码：https://github.com/TauricResearch/TradingAgents/blob/9fa1196fffbcfd9de5146d2dd2869df84ab99838/tradingagents/graph/setup.py
- 证据预取源码：https://github.com/TauricResearch/TradingAgents/blob/9fa1196fffbcfd9de5146d2dd2869df84ab99838/tradingagents/agents/analysts/sentiment_analyst.py
- 时间截点源码：https://github.com/TauricResearch/TradingAgents/blob/9fa1196fffbcfd9de5146d2dd2869df84ab99838/tradingagents/dataflows/date_window.py
- 许可证：https://github.com/TauricResearch/TradingAgents/blob/9fa1196fffbcfd9de5146d2dd2869df84ab99838/LICENSE

源码观察：行情、新闻、情绪、基本面分析器拥有独立消息上下文，可以并行执行；分析汇合后进入多空讨论和风险审议。单个分析器有工具调用轮次上限。情绪分析先由程序获取并按日期裁剪材料，再让模型输出结构化解释。时间工具区分“未覆盖该历史窗口”与“该窗口没有新闻”，并限制回测使用晚于分析日期的信息。

适合本项目的概念借鉴：先构造证据包，再运行相互分离的异动解释与风险审阅；保留明确截止时间、失败状态和有限调用预算。日报不需要移植完整交易决策图，也不应把多名模型相互同意当作事实核验或上涨概率。

许可观察：所读 LICENSE 为 Apache-2.0。当前仅参考设计，不复制其源码或提示词。若后续复制、改写或分发上游代码，应按实际 LICENSE 和 NOTICE（如有）保留相应声明；API 数据授权另行处理。

## 2. FinRobot

- 仓库：https://github.com/AI4Finance-Foundation/FinRobot
- 核验 HEAD：`63e1884a42ea7b729551a5424b4bd6a65af636e0`。
- V2 README：https://github.com/AI4Finance-Foundation/FinRobot/blob/63e1884a42ea7b729551a5424b4bd6a65af636e0/finrobot_desktop/README.md
- 研究管线源码：https://github.com/AI4Finance-Foundation/FinRobot/blob/63e1884a42ea7b729551a5424b4bd6a65af636e0/finrobot_desktop/finrobot/engine/pipelines/equity_research.py
- 管线入口契约：https://github.com/AI4Finance-Foundation/FinRobot/blob/63e1884a42ea7b729551a5424b4bd6a65af636e0/finrobot_desktop/finrobot/engine/pipelines/base.py
- 分析器行为契约：https://github.com/AI4Finance-Foundation/FinRobot/blob/63e1884a42ea7b729551a5424b4bd6a65af636e0/finrobot_desktop/finrobot/engine/instructions.md
- 许可证：https://github.com/AI4Finance-Foundation/FinRobot/blob/63e1884a42ea7b729551a5424b4bd6a65af636e0/LICENSE
- 声明：https://github.com/AI4Finance-Foundation/FinRobot/blob/63e1884a42ea7b729551a5424b4bd6a65af636e0/NOTICE

源码观察：V2 将数据、计算、分析叙述及报告区分为不同层。研究管线调用代码计算、结构化验证器和叙述数字审计；可选 SEC 请求设置超时并显式降级。催化剂处理会筛除过期新闻、合并重复材料、带入原始公告链接，避免把重复报道计为多个独立事件。代码明确区分内部事件权重与可展示的预测概率。旧版 AutoGen 示例与 V2 的能力和约束不同，不宜混用其声明。

适合本项目的概念借鉴：价格、涨跌幅、成交量、日期及交易日由代码确定；模型只能解释给定数据。每段主要结论绑定证据标识及材料时间。缺失信息保留未知状态。模型文本验证不过时继续展示原始行情和规则说明，不补造数值，也不把缺少新闻解释成没有风险。

许可观察：所读 LICENSE 为 Apache-2.0；NOTICE 还要求分发时保留声明，并单独说明商标。当前不复制上游代码、品牌或提示词，也不继承其完整 Python、PydanticAI、Tauri 依赖。

## 本站推荐落地边界

1. **确定性数据层**：行情、上一完整交易日筛选、七天日历及 AI 行业标签由现有 Node 模块产生。证据包携带 `id`、`sourceUrl`、`publishedAt`、`observedAt`、`tradeDate`，不让模型更改这些事实。
2. **有界解释层**：将有长度限制的报价、事件、新闻摘要交给可配置 LLM；让其分别给出已知事实、可能机制、反方解释和待核验点。把外部文章当作不可信输入，禁止执行其中指令。
3. **审阅和校验**：约束 JSON 结构；引用只能来自证据包已存在的 ID；个股与事件必须已在输入中。价格、百分比、日期仍展示程序原值。没有直接材料时只能说明“可能相关，尚未证实”，不能写成已确认的异动原因。
4. **可观察降级**：未配置密钥、请求超时、限流、非法输出或缺少有效引用，均标注具体 LLM 状态并回退到规则说明；行情和官方日历继续可用。不要伪装成模型已生成分析。
5. **可重现日报**：固定生成时间和数据截止时间，保存输入证据及模型名称、提示词版本、生成状态；归档回看不自动拿最新新闻改写历史原因。
6. **覆盖范围**：本地跟踪清单和 Nasdaq 财报筛选不是全市场覆盖；官方日历不涵盖全部突发政治、监管、地缘事件。来源异常应展示覆盖缺口。

以上为结合两仓库源码和当前网站任务做出的实施建议；并未直接移植上游算法、策略、模型参数或代码，也没有承诺任何预测准确率或投资收益。
