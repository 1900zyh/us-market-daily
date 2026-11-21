# GitHub 金融 LLM 方案核查与本项目实现建议

本轮直接检查了项目维护者的 README、许可证与实际源代码；以下区分“源码中存在的机制”和“对美股观察网站的实现建议”。没有运行这些仓库的训练、回测或交易流程，也不把仓库的模型输出当成已经验证的收益预测。

## 1. virattt/ai-hedge-fund

核查版本：`5c553b5222044f6a5527bd377b4104c50ee0ad28`。当前代码布局为 `hedge_fund/`，不沿用旧版本 `src/agents/` 路径的描述。

- [LLMAgent 实现](https://github.com/virattt/ai-hedge-fund/blob/5c553b5222044f6a5527bd377b4104c50ee0ad28/hedge_fund/signals/llm_agent.py)：先构造指定时点的财务快照，模型返回值经过解析验证；模型调用或解析失败记录为 abstain。缓存记录模型、时点、快照 hash、提示词和响应，便于重复使用与检查。
- [Buffett 分析提示词](https://github.com/virattt/ai-hedge-fund/blob/5c553b5222044f6a5527bd377b4104c50ee0ad28/hedge_fund/signals/buffett.py)：人物代理实际是系统提示词与分析清单；要求只依据输入数据、禁止编造数值，信息不足时给出中性判断。角色数量本身不等于信息量或准确率。
- [LLM provider 客户端](https://github.com/virattt/ai-hedge-fund/blob/5c553b5222044f6a5527bd377b4104c50ee0ad28/hedge_fund/llm/client.py)：通过统一接口隔离供应商。Jev 适配器包含请求超时、有限重试、拒绝重定向和递归密钥脱敏；不能据此声称其他每个供应商适配器都具有完全相同的机制。
- [类型契约](https://github.com/virattt/ai-hedge-fund/blob/5c553b5222044f6a5527bd377b4104c50ee0ad28/hedge_fund/llm/contract.py)：约束只使用提供的证据并遵守时点限制，验证结构和数值；明确区分观点强度、模型回答信心与获利概率。
- [架构说明](https://github.com/virattt/ai-hedge-fund/blob/5c553b5222044f6a5527bd377b4104c50ee0ad28/hedge_fund/README.md)：数据、观点、组合、风险和执行分层。对本网站有用的是数据与叙述分层，网站不需要复制交易执行部分。
- [许可证](https://github.com/virattt/ai-hedge-fund/blob/5c553b5222044f6a5527bd377b4104c50ee0ad28/LICENSE)：MIT。若复制其代码或实质性部分，需要保留版权及许可声明。本次仅研究架构与接口设计，网站实现不直接复制其代理代码。

## 2. AI4Finance-Foundation/FinGPT

核查版本：`464916bdf91afaaecb5a504aee1b2a66bc444653`。

- [Forecaster 数据流程](https://github.com/AI4Finance-Foundation/FinGPT/blob/464916bdf91afaaecb5a504aee1b2a66bc444653/fingpt/FinGPT_Forecaster/data.py)：组织价格、相关新闻和财务数据；财务数据选择强调在预测决策时点已经公开，而非仅依据财报覆盖期。它还包含训练数据构建步骤，不能直接等同于线上预测服务。
- [Forecaster 提示词构造](https://github.com/AI4Finance-Foundation/FinGPT/blob/464916bdf91afaaecb5a504aee1b2a66bc444653/fingpt/FinGPT_Forecaster/prompt.py)：把时间窗口、价格变化、新闻标题/摘要和财务信息组织进上下文。其生成训练答案的流程会把已知未来收益分箱标签传入提示词；该步骤服务于训练样本构造，不能照搬成在线预测，更不能把生成解释当作样本外预测证据。
- [MultiAgentsRAG 说明](https://github.com/AI4Finance-Foundation/FinGPT/blob/464916bdf91afaaecb5a504aee1b2a66bc444653/fingpt/FinGPT_MultiAgentsRAG/README.md)：提出外部知识检索与多代理批评、修订。README 的研究目标不证明任何一次实际回答完全没有幻觉，也不能替代输出验证。
- [许可证](https://github.com/AI4Finance-Foundation/FinGPT/blob/464916bdf91afaaecb5a504aee1b2a66bc444653/LICENSE)：代码仓库为 MIT。模型权重、底座模型与外部数据源的使用条件应分别核查，不能把仓库许可证扩大解释为所有数据和权重的授权。

## 3. OpenBB 的定位与许可补充

[OpenBB 主仓库](https://github.com/openbq-org/OpenBB)目前把数据平台定位为公开、授权与自有数据的统一接入层，输出可以给 Python、REST、MCP 等应用使用。旧的 `OpenBB-finance/OpenBB` 地址重定向到 `openbq-org/OpenBB`。本轮读取的 [develop 分支 LICENSE](https://github.com/openbq-org/OpenBB/blob/develop/LICENSE)为 Apache-2.0；不能仅凭旧文章假设当前仍是旧许可。这里是数据接入架构参考，不声称本网站已经集成 OpenBB。

## 4. 对本网站的实施判断

以下是基于上述代码阅读作出的设计推论，不是对那些仓库功能的额外事实断言。

1. **先采集、后分析。** 行情、官方日历、公司资讯保留交易日、发布时间、抓取时间和 URL。日涨跌幅、相对标普强弱与量比由确定性代码计算，再作为模型的已知事实输入。
2. **使用有边界的证据包。** 给每条来源分配稳定编号，包含来源标题、时间与链接。LLM 只能引用本次证据包里的编号；服务器拒绝或剔除不在白名单中的引用。仅有标题时，应标明缺少全文而不是让模型声称阅读过原文。
3. **让 LLM 做有证据的解读。** 可分别输出异动解释、未来七日催化路径、反面因素和待核实事项；事实与推测分开。系统提示词要求不补写行情、不发明发布日期、不把相关性说成已证实因果。
4. **状态应可验证。** 未配置密钥、服务失败、输出无效、实际生成完成是不同状态。没有实际成功响应时，页面显示未生成；既有规则摘要继续使用自己的标签，不能冒充大模型分析。
5. **保留审计信息。** 成功结果记录模型 ID、生成时间、输入报告日期、证据 ID 和提示词版本。缓存身份应包含证据和模型；证据变更后旧结论不能不加说明地重用。
6. **限制输出与凭证暴露。** 配置在服务端保存；状态接口只报告是否已配置，绝不回传 API key。模型返回的文本、错误体、归档与日志都需防止出现供应商回显的密钥；前端采用转义渲染。
7. **不要提供伪精确胜率。** 多代理讨论与漂亮的解释并不自动产生可校准概率。要做概率预测，需要独立定义标签、历史时点数据、训练/验证划分、滚动样本外回测和校准检验。

## 5. 本轮质量检查

AI 范围浏览器验收使用明确的测试 fixture：默认展示 NVDA、AMD；TSLA 仅切换到全市场后出现。另设置一个只存在于 `aiMovers` 的 MSFT，确认 AI 页面使用独立 AI 结果集，而不是从全市场截断名单中再次过滤。芯片/云平台筛选、方法说明、原有搜索/关注/图表/归档/刷新以及桌面与手机布局均通过。

LLM 浏览器验收也使用明确的本地测试响应：未配置密钥时不显示已生成结果；点击分析先打开设置且不发起推理；密码输入、保存后清空、重开不回填、状态接口不返回密钥、不写入 localStorage 均通过。保存配置本身不会伪造分析；只有返回模型结果的测试响应后才显示解读，并呈现证据目录里的 BLS、SEC 来源链接。本测试不访问真实外部模型，不代表已配置用户的 API key，也不证明模型输出事实无误。
