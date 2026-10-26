# Ticket Triage Agent

A support-ticket triage system that classifies incoming tickets, grounds its answer in a knowledge base, drafts a reply with citations, and escalates to a human when it should not answer.

Built to be runnable in one command with **no API key and no dependencies**, and to be **measurable**: the repository ships an evaluation harness and a rule-based baseline, so any claim about quality can be checked rather than asserted.

---

## Why this exists

Support teams lose time on three different problems, and a single classifier only solves one of them:

1. **Routing** — which queue does this ticket belong to, and how urgent is it?
2. **Grounding** — is the answer actually supported by our policy, or did the model make it up?
3. **Judgement** — when is it *wrong* to answer automatically?

A ticket that says "we filed a chargeback and our workspace is suspended" must not receive a friendly generated reply. It must reach a human, fast. That decision is more important than the category label, and it is the part most demos skip.

## What it does

```
ticket ──▶ retrieve KB excerpts ──▶ classify (category + priority + confidence)
              │                              │
              │                              ├── confidence too low / no grounding ──▶ escalate
              │                              └── policy trigger (security, legal,
              │                                   chargeback, customer asked for a human) ──▶ escalate
              ▼
        draft reply with [doc#section] citations ──▶ grounding check ──▶ send
```

Every run prints a **trace**: which tool was called, with what query, and what came back. When retrieval is weak the agent retries with extracted keywords and says so in the trace.

## Results on the bundled evaluation set (20 labelled tickets)

| metric | baseline (keywords, no retrieval) | agent |
| --- | --- | --- |
| category accuracy | 95.0% | 100.0% |
| priority accuracy | 85.0% | 85.0% |
| exact match (category + priority) | 80.0% | 85.0% |
| retrieval hit@3 | — | 95.0% |
| **citation coverage** | **0.0%** | **100.0%** |
| escalation precision | — | 85.7% |
| **escalation recall** | **0.0%** | **100.0%** |

Both rows are produced by `npm run eval`. Numbers are from the offline deterministic engine described below.

**How to read this honestly.** Twenty tickets, written by the same person who wrote the decision rules, is a smoke test — not a benchmark. A perfect category score here says the rules are internally consistent, and nothing about real traffic. The set exists so that a change can be rejected when it makes things worse, which is a different job from proving the system is good.

The two metrics that do not depend on the size of the set are the structural ones:

- **Citation coverage 0% → 100%**: every automated reply points at the document section that supports it, so a reviewer can audit it. The baseline cannot cite, by construction.
- **Escalation recall 0% → 100%**: every ticket that policy says must reach a human does reach a human. The baseline cannot escalate, by construction.

Priority sits at 85% in both rows, and that is the weakest axis. The misses are documented in *Known limitations* — they are cases where priority comes from policy rather than from the wording of the ticket.

## Quickstart

Requires Node.js >= 22.6 (uses native TypeScript type stripping). No `npm install` needed — there are zero runtime dependencies.

```bash
npm run demo     # triage 3 tickets and print the full trace
npm run eval     # run the evaluation set against baseline and agent
npm run triage -- --text "Our card was declined and we got dunning emails" --tier pro
```

Run against a real model (any OpenAI-compatible endpoint — OpenAI, DeepSeek, Qwen, Moonshot, vLLM, Ollama):

```bash
export LLM_PROVIDER=openai
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_API_KEY=sk-...
export LLM_MODEL=gpt-4o-mini
npm run eval
```

## Design decisions

**1. Hybrid retrieval instead of pure vector search.**
Support tickets and policy documents share exact tokens that matter — `429`, `2FA`, `VAT`, `P1`. Dense similarity blurs those; lexical matching does not. The retriever scores `0.55 × cosine + 0.45 × normalised BM25`, so a ticket containing `429` reliably finds the rate-limit section even when the surrounding prose is different.

**2. Retrieved context is capped so it can never outvote an explicit signal.**
An early version let retrieved documents add a flat boost to their category. Result: a ticket about an invoice with the word "accounting" in it was routed to `account`, because "accounting" was matched as a substring of the keyword "account", and the retrieved `account` chunk outvoted the correct `billing` hit. Two fixes: word-boundary matching, and capping the retrieval boost at `0.7 × score`. Recorded in `docs/architecture.md`.

**3. Grounding is enforced in code, not trusted from the model.**
After drafting, the agent extracts `[doc#section]` references and checks each one against the chunks retrieval actually returned. If the model cites something outside that set, or cites nothing at all, the agent attaches the real retrieved chunks and records the correction in the trace. A reply that cannot be grounded is a bug, not a stylistic issue.

**4. Escalation is a policy layer, not a model decision.**
Escalation triggers live in code and are readable by a support manager: confidence below threshold, no KB support, security or legal keywords, chargeback, data-deletion request, customer asked for a human, enterprise P1. A model can be persuaded to skip these; a `if` statement cannot.

## Known limitations

- **Priority is the weakest axis (85%).** The residual misses are cases where a question about an error looks like an incident ("we get 401 against production — is there a separate key per environment?" is a P3 how-to, not a P2 outage), and cases where priority depends on policy the text does not state (a GDPR deletion request is P2 because of the legal obligation, not because of its wording). A real deployment needs the priority rules expressed as explicit policy inputs rather than inferred from prose.
- **The offline engine is a rule set, not a language model.** It exists so the repository runs with no cost and so regressions are detectable in CI. It will not handle multilingual tickets, sarcasm, or long multi-issue threads.
- **The knowledge base is 29 synthetic chunks.** Retrieval quality on a real corpus of thousands of documents needs chunk-size tuning and a reranker; hit@3 at this scale says little.
- **No PII handling, no ticket-system integration, no rate limiting on the LLM path.** This is a reference implementation of the decision layer, not a production service.

## Layout

```
src/
  rag.ts      chunking, hybrid retrieval (cosine + BM25), deterministic embeddings
  llm.ts      LLM adapter: offline rule engine + OpenAI-compatible client
  agent.ts    the loop: retrieve → classify → policy gate → draft → grounding check
  eval.ts     baseline, agent run, metrics
  cli.ts      demo / eval / ad-hoc triage
data/
  kb/         knowledge base (5 documents, 29 chunks)
  eval/       20 labelled tickets
docs/
  architecture.md   decision log, including the two bugs above
  demo-script.md    3-minute walkthrough
```

## License

MIT
