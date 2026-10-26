# 3-minute demo script

> 用法：录屏时照着说。英文句子全部控制在 12 个词以内，短句、少从句，方便你背。
> 中文注释是给你理解语义的，不要念出来。

## 开场（15 秒）

**你要做什么**：先展示 `README.md` 的 Results 表格，不要先讲代码。

> "This is a support ticket triage agent. It reads a ticket, finds the right policy, and drafts a reply. Every reply has a citation. And it escalates when it should not answer."

中文：这是一个客服工单分流 Agent。它读工单、找到对应政策、起草回复。每条回复都有引用。该转人工时它会转。

**为什么先给结论**：面试官在前 15 秒决定要不要认真听。先说结果，再说过程。

## 第一段：一个正常工单（45 秒）

**终端输入**：

```bash
npm run triage -- --text "We started 9 days ago and only used a small part of the quota. We would like to cancel and get our money back." --tier free
```

> "Here the agent found the refund policy. It set priority to P3. The confidence is 0.84, so it answers."
>
> "Look at the citations. `refunds#trial-period`. That is a real section in the knowledge base."

中文：这里它找到了退款政策，定级 P3，置信度 0.84，所以它自己回答。看引用——`refunds#trial-period`，这是知识库里真实存在的小节。

**要指的地方**：trace 里的 `searchKnowledgeBase` 那一行。

## 第二段：该转人工的时候（45 秒）

```bash
npm run triage -- --text "We see a login from a country we do not operate in. This looks like account takeover." --tier enterprise
```

> "Same flow. Different decision. This one escalates."
>
> "Two reasons. It is a security incident. And it is an enterprise P1."
>
> "The output is a handoff note, not a customer reply. That is on purpose."

中文：同样的流程，不同的决定。这个转人工了。两个原因：安全事件，加企业客户 P1。输出的是交接单，不是给客户的回复——这是故意的。

**这是整个 demo 最重要的一段**。如果你的面试官只记一件事，让他记住这个：**它知道什么时候该闭嘴。**

## 第三段：评测（45 秒）

```bash
npm run eval
```

> "This is the part I care about most. There is a baseline here. Keyword matching, no retrieval."
>
> "The baseline gets 95% on category. It is a strong baseline, because I wrote it myself."
>
> "But twenty tickets is a smoke test, not a benchmark. So I do not trust the accuracy numbers."
>
> "What I trust are the structural numbers. Citation coverage goes from zero to one hundred. Escalation recall goes from zero to one hundred."

中文：这是我最在意的部分。这里有个基线——纯关键词、不检索。基线分类准确率 95%，这个基线很强，因为它是我自己写的。但 20 条工单只是冒烟测试，不是基准，所以我不信准确率数字。我信的是结构性指标：引用覆盖率从 0 到 100，转人工召回率从 0 到 100。

**这段话是设计过的**。主动说“我不信我自己的准确率”，比说“我做到 100%”可信得多。面试官见多了什么都说自己赢的候选人。

**如果面试官追问**：“那你为什么还要那个评测集？”
> "So a change can be rejected when it makes things worse. Not to prove it is good."

## 第四段：一个真实的 bug（30 秒）

> "This repository had a bug. A ticket about an invoice was routed to 'account'."
>
> "Because the word 'accounting' matched the keyword 'account'. Substring matching."
>
> "And the retrieved document outvoted the correct keyword hit. I fixed both. It is in the decision log."

中文：这个项目有过一个 bug。一张关于发票的工单被分到了 account 类。因为 "accounting" 这个词匹配上了关键词 "account"——子串匹配。而且检索结果压过了正确的关键词命中。两个都修了，写在决策日志里。

**为什么讲 bug**：讲“我做得很好”没有说服力，讲“我发现了一个隐蔽的错误并修掉”有。这是简历上写不出来的东西。

## 常见追问与答法

**Q: 为什么不用纯向量检索？**
> "Tickets contain exact tokens. 429. 2FA. VAT. Dense search blurs them. So I use hybrid."

**Q: 优先级只有 85%，怎么办？**
> "Some priorities come from policy, not from the text. A GDPR request is P2 because of the law. So priority rules should be explicit inputs, not guesses. That is my next step."

**Q: 这个能上生产吗？**
> "No. There is no PII handling and no ticket system integration. It is the decision layer only. The next step is an entailment check on citations."

**Q: 你一个人做的？**
> "Yes. I designed the retrieval and the escalation policy. I wrote the evaluation set myself."

⚠️ 注意：最后这题必须如实回答。如果你用了 AI 辅助写代码，就说用了——你本来就在用 Cursor，这是加分项，不是减分项：

> "I built it with AI assistance — Cursor. Same as I would at work. But the design decisions are mine."

## 录屏前的检查清单

- [ ] `npm run demo` 能跑通，输出不报错
- [ ] `npm run eval` 能跑通，数字和 README 一致
- [ ] 终端字号调到 16pt 以上，录屏看得清
- [ ] 提前把三条命令复制到剪贴板，别现场敲
- [ ] 第一句话先练 10 遍——开场卡住，后面全乱
