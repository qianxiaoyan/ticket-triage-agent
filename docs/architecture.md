# Architecture and decision log

## Component map

| Component | File | Responsibility |
| --- | --- | --- |
| Chunker | `src/rag.ts` | split markdown by `##` headings, split long sections at paragraph boundaries |
| Index | `src/rag.ts` | per-chunk term frequencies, document frequencies, hashed embeddings |
| Retriever | `src/rag.ts` | hybrid score: `0.55 × cosine + 0.45 × normalised BM25`, top-k |
| LLM adapter | `src/llm.ts` | one interface, two implementations: offline rule engine, OpenAI-compatible client |
| Agent loop | `src/agent.ts` | retrieve → retry → classify → policy gate → draft → grounding check |
| Policy | `src/agent.ts` | escalation triggers, readable by a non-engineer |
| Evaluation | `src/eval.ts` | baseline run, agent run, per-ticket diff |

## Why a baseline is in the repository

A demo that only shows an output is not evidence. The baseline is a keyword classifier with no retrieval and no escalation, and it exists so that every change to the agent can be expressed as a delta. If a retrieval change does not move `retrieval hit@3`, it did not work.

The baseline also keeps the honest part honest: on this evaluation set the baseline already reaches 95% category accuracy, because the rules were written while reading the same policy documents. That is not a flaw in the baseline, it is the reason the evaluation set needs to grow before any claim about the LLM path means anything.

## Decision log

### D1 — Chunk on headings, not fixed windows

**Context.** Fixed 512-token windows cut policy sentences in half. "A refund is available in full if the customer cancels within 14 days" loses its meaning if the window ends at "cancels within".

**Decision.** Split on `##` headings; only split a section further if it exceeds 900 characters, and then only at paragraph boundaries. Chunk ids are stable (`doc#heading`), so citations survive re-indexing.

**Trade-off.** A heading that covers two topics produces one large chunk with a diluted embedding. Acceptable at 29 chunks; a real corpus needs sub-heading structure or semantic splitting.

### D2 — Deterministic hashed embeddings, not a hosted embedding model

**Context.** The repository must run with no API key, no cost, and no network, so that the evaluation is reproducible by anyone who clones it.

**Decision.** Feature hashing into 256 dimensions, L2 normalised, with unigrams plus a discounted bigram bucket. Cosine similarity behaves like a real vector index; results are byte-identical across runs.

**Trade-off.** Semantic generalisation is weak: "money back" and "refund" are only linked through the lexical half of the score. `embed()` is isolated behind a single function so a hosted model can be dropped in without touching the retriever.

### D3 — Cap the retrieval boost (a bug fix)

**Symptom.** A ticket about an incorrect invoice was classified as `account`.

**Root cause.** Two compounding issues. First, keyword matching used `String.includes`, so the word "accounting" matched the keyword "account". Second, retrieved chunks added a flat `+1.6` to their category, which was larger than a single keyword hit (`+1`), so the wrong category won on retrieval evidence alone.

**Fix.** Word-boundary matching for single-word keywords; retrieval boost capped at `0.7 × min(score, 1)`; a category needs at least `1.0` total score or the ticket falls back to `other`.

**What this says about the design.** A retrieval system that can outvote explicit signals is worse than no retrieval, because failures become silent. Signals should add, not dominate.

### D4 — Retry retrieval once with extracted keywords

**Symptom.** Short, vague tickets ("refund?") retrieved policy sections about unrelated topics with a top score around 0.2.

**Decision.** If the top score is below `0.35`, re-run the query with the distinct words longer than three characters, keep whichever result set scores higher, and record the retry in the trace.

**Trade-off.** One extra retrieval per weak ticket. Bounded, and visible — which matters more than the cost.

### D5 — Enforce citations after generation

**Context.** Prompt instructions to "cite sources" are followed most of the time, and the failure mode is dangerous: a plausible reply with no source.

**Decision.** Parse `[doc#section]` references from the draft, verify each against the retrieved set, and if none survive, append the actual retrieved chunks. The correction is written into the trace.

**Trade-off.** A model that cites the wrong-but-retrieved chunk still passes. Catching that needs an entailment check, which is the natural next step.

### D6 — Escalation in code, not in the prompt

**Context.** The most expensive failure is a confident reply to a ticket that needed a human: a chargeback, a security incident, a legal threat.

**Decision.** Triggers are explicit conditions in `decideEscalation()`. The model's confidence is only one input, and it is not the deciding one for the triggered categories.

**Trade-off.** A rigid list misses novel escalation cases. Mitigation: the list is short, readable, and reviewed by support leads rather than engineers — which is the point.

### D7 — Prune weak chunks before drafting

**Symptom.** A billing ticket about a declined card cited `api#sandbox-environment`. Retrieval returned four chunks because `k=4`; only one was relevant.

**Why it matters.** An irrelevant citation is worse than no citation: it makes an ungrounded claim look sourced, and it teaches reviewers to stop checking.

**Decision.** After retrieval, drop any chunk scoring below `max(0.25, 0.6 × topScore)`. The count of kept chunks is written to the trace so a silent collapse to one chunk is visible.

**Side effect.** Category accuracy rose from 95% to 100% on the evaluation set: the discarded chunk had been adding category evidence it should not have had. That is a side effect, not the goal — the goal was auditability.

## Evaluation design

| Metric | Definition | Why it is here |
| --- | --- | --- |
| category accuracy | predicted category == label | routing quality |
| priority accuracy | predicted priority == label | SLA exposure |
| exact match | both correct | the number a support manager cares about |
| retrieval hit@3 | the expected document appears in the top 3 citations | did retrieval do its job |
| citation coverage | the reply cites at least one retrieved chunk | auditability |
| escalation precision | escalated tickets that should have been escalated | cost of over-escalating |
| escalation recall | should-have-escalated tickets that were escalated | **safety**; ranked above precision |

Recall is deliberately preferred to precision: a redundant handoff costs minutes, a missed security escalation costs an incident.

## Next steps that would matter

1. Replace `embed()` with a hosted embedding model and add a cross-encoder reranker; measure the change in hit@3.
2. Grow the evaluation set from 20 to 300 tickets sampled from real traffic, including multi-issue and non-English tickets.
3. Add an entailment check so a cited-but-irrelevant chunk is caught, not just a missing citation.
4. Express priority rules as explicit policy inputs (contract tier, legal flag, security flag) instead of inferring them from prose.
5. Log every escalation with its trigger so the policy list can be reviewed monthly.
