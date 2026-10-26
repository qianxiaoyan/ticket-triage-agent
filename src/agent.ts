import type { Retriever } from './rag.ts';
import type { Llm } from './llm.ts';
import { slaFor } from './llm.ts';
import type { AppConfig } from './config.ts';
import type { ScoredChunk, Ticket, TriageResult } from './types.ts';

export interface TriageDeps {
  retriever: Retriever;
  llm: Llm;
  config: AppConfig;
}

const LOW_RETRIEVAL_THRESHOLD = 0.35;

const HUMAN_REQUEST_PATTERNS = [
  'speak to a human', 'talk to a human', 'real person', 'human agent', 'your manager',
  'escalate this', 'account manager', 'call me', 'phone me',
];

const MUST_ESCALATE_PATTERNS = [
  'legal action', 'lawyer', 'lawsuit', 'gdpr request', 'delete my data', 'data deletion',
  'chargeback', 'dispute the charge', 'security incident', 'breach', 'unauthorized access',
  'account takeover', 'hacked',
];

function refineQuery(ticket: Ticket): string {
  const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
  const words = text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 3);
  return [...new Set(words)].slice(0, 12).join(' ');
}

/**
 * Drop chunks that are far below the best match. Retrieval always returns k results
 * even when only one of them is relevant, and an irrelevant citation is worse than
 * no citation: it makes an ungrounded claim look sourced.
 */
function pruneChunks(chunks: ScoredChunk[]): ScoredChunk[] {
  if (!chunks.length) return chunks;
  const floor = Math.max(0.25, chunks[0].score * 0.6);
  return chunks.filter((chunk) => chunk.score >= floor);
}

/**
 * The agent loop. Each step names the tool it used so the trace can be shown to a
 * reviewer, and so a failed retrieval is visible instead of silently degrading.
 */
export async function triageTicket(ticket: Ticket, deps: TriageDeps): Promise<TriageResult> {
  const { retriever, llm, config } = deps;
  const trace: string[] = [];

  const firstQuery = `${ticket.subject} ${ticket.body}`;
  let chunks: ScoredChunk[] = retriever.search(firstQuery, config.topK);
  trace.push(
    `searchKnowledgeBase(query="${truncate(firstQuery)}") -> ${chunks.length} chunks, top=${chunks[0]?.score.toFixed(2) ?? 'n/a'}`,
  );

  if (!chunks.length || chunks[0].score < LOW_RETRIEVAL_THRESHOLD) {
    const secondQuery = refineQuery(ticket);
    const retry = retriever.search(secondQuery, config.topK);
    trace.push(
      `retrieval weak, retrying with keywords -> ${retry.length} chunks, top=${retry[0]?.score.toFixed(2) ?? 'n/a'}`,
    );
    if (retry.length && (!chunks.length || retry[0].score > chunks[0].score)) chunks = retry;
  }

  const sla = slaFor(ticket.customerTier);
  chunks = pruneChunks(chunks);
  trace.push(`pruneChunks() -> ${chunks.length} chunks kept`);
  trace.push(`getSlaPolicy(tier="${ticket.customerTier}") -> first response ${sla.firstResponse}`);

  const classification = await llm.classify({ ticket, chunks, sla });
  trace.push(
    `classify() -> ${classification.category}/${classification.priority} confidence=${classification.confidence.toFixed(2)}`,
  );

  const escalation = decideEscalation(ticket, classification, chunks, config);
  if (escalation) trace.push(`escalate(reason="${escalation}")`);

  if (escalation) {
    return {
      ticketId: ticket.id,
      category: classification.category,
      priority: classification.priority,
      confidence: classification.confidence,
      escalate: true,
      escalationReason: escalation,
      citations: chunks.slice(0, 2).map((chunk) => chunk.id),
      draft: handoffNote(ticket, classification, escalation, sla.firstResponse),
      trace,
    };
  }

  const rawDraft = await llm.draft({ ticket, chunks, sla, classification });
  const { draft, citations } = enforceGrounding(rawDraft, chunks);
  trace.push(`draft() -> ${draft.split(/\s+/).length} words, citations=[${citations.join(', ')}]`);

  return {
    ticketId: ticket.id,
    category: classification.category,
    priority: classification.priority,
    confidence: classification.confidence,
    escalate: false,
    citations,
    draft,
    trace,
  };
}

function decideEscalation(
  ticket: Ticket,
  classification: { category: string; priority: string; confidence: number },
  chunks: ScoredChunk[],
  config: AppConfig,
): string | undefined {
  const text = `${ticket.subject} ${ticket.body}`.toLowerCase();

  if (MUST_ESCALATE_PATTERNS.some((pattern) => text.includes(pattern))) {
    return 'policy: legal, security, or data-deletion request';
  }
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => text.includes(pattern))) {
    return 'policy: customer asked for a human';
  }
  if (classification.priority === 'P1' && ticket.customerTier === 'enterprise') {
    return 'policy: enterprise P1 requires on-call paging';
  }
  if (classification.confidence < config.escalationConfidence) {
    return `policy: confidence ${classification.confidence.toFixed(2)} below threshold`;
  }
  if (!chunks.length || chunks[0].score < LOW_RETRIEVAL_THRESHOLD) {
    return 'policy: answer cannot be grounded in the knowledge base';
  }
  return undefined;
}

function handoffNote(
  ticket: Ticket,
  classification: { category: string; priority: string },
  reason: string,
  firstResponse: string,
): string {
  return [
    `Internal handoff for ticket ${ticket.id} (${ticket.customerTier} tier).`,
    `Triage: ${classification.category} / ${classification.priority}.`,
    `Escalation reason: ${reason}.`,
    `SLA first response: ${firstResponse}.`,
    `Customer message: ${truncate(`${ticket.subject} — ${ticket.body}`, 200)}`,
  ].join('\n');
}

function enforceGrounding(draft: string, chunks: ScoredChunk[]): { draft: string; citations: string[] } {
  const allowed = new Set(chunks.map((chunk) => chunk.id));
  const referenced = [...draft.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]).filter((id) => allowed.has(id));

  if (referenced.length) return { draft, citations: [...new Set(referenced)] };

  // The model produced an ungrounded reply. Rather than trusting it, attach the
  // chunks retrieval actually returned and flag it in the trace.
  const fallback = chunks.slice(0, 2).map((chunk) => chunk.id);
  return {
    draft: `${draft}\n\nSources: ${fallback.map((id) => `[${id}]`).join(' ')}`,
    citations: fallback,
  };
}

function truncate(value: string, max = 60): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}
