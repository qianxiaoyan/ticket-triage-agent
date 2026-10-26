import { readFile } from 'node:fs/promises';
import type { Category, EvalReport, EvalRow, LabeledTicket, ScoredChunk } from './types.ts';
import type { TriageDeps } from './agent.ts';
import { triageTicket } from './agent.ts';
import { MockLlm, slaFor } from './llm.ts';

const EXPECTED_DOC: Record<Category, string> = {
  billing: 'billing',
  refund: 'refunds',
  account: 'account',
  api: 'api',
  other: 'sla',
};

export async function loadEvalSet(path: string): Promise<LabeledTicket[]> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as LabeledTicket[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 1000;
}

function buildReport(
  name: string,
  rows: EvalRow[],
  labels: Map<string, LabeledTicket>,
): EvalReport {
  let categoryOk = 0;
  let priorityOk = 0;
  let exact = 0;
  let retrievalHit = 0;
  let citationCovered = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const row of rows) {
    if (row.categoryOk) categoryOk += 1;
    if (row.priorityOk) priorityOk += 1;
    if (row.categoryOk && row.priorityOk) exact += 1;
    if (row.retrievalHit) retrievalHit += 1;
    if (row.citationCovered) citationCovered += 1;

    const label = labels.get(row.id);
    if (label?.expectedEscalate && row.escalated) truePositive += 1;
    if (!label?.expectedEscalate && row.escalated) falsePositive += 1;
    if (label?.expectedEscalate && !row.escalated) falseNegative += 1;
  }

  return {
    name,
    total: rows.length,
    categoryAccuracy: ratio(categoryOk, rows.length),
    priorityAccuracy: ratio(priorityOk, rows.length),
    exactMatch: ratio(exact, rows.length),
    retrievalHitRate: ratio(retrievalHit, rows.length),
    escalationPrecision: ratio(truePositive, truePositive + falsePositive),
    escalationRecall: ratio(truePositive, truePositive + falseNegative),
    citationCoverage: ratio(citationCovered, rows.length),
    rows,
  };
}

function retrievalHit(chunks: ScoredChunk[], category: Category): boolean {
  const expected = EXPECTED_DOC[category];
  return chunks.slice(0, 3).some((chunk) => chunk.docId === expected);
}

/**
 * Baseline: keyword classifier with no retrieval and no tools.
 * This is the number the agent has to beat. Keeping it in the repo is deliberate —
 * a demo without a baseline is not evidence of anything.
 */
export async function runBaseline(tickets: LabeledTicket[]): Promise<EvalReport> {
  const llm = new MockLlm();
  const rows: EvalRow[] = [];
  const labels = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  for (const ticket of tickets) {
    const result = await llm.classify({ ticket, chunks: [], sla: slaFor(ticket.customerTier) });
    rows.push({
      id: ticket.id,
      categoryOk: result.category === ticket.expectedCategory,
      priorityOk: result.priority === ticket.expectedPriority,
      retrievalHit: false,
      escalated: false,
      expectedEscalate: ticket.expectedEscalate,
      citationCovered: false,
    });
  }
  return buildReport('baseline (keyword only, no retrieval)', rows, labels);
}

export async function runAgent(deps: TriageDeps, tickets: LabeledTicket[]): Promise<EvalReport> {
  const rows: EvalRow[] = [];
  const labels = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  for (const ticket of tickets) {
    const result = await triageTicket(ticket, deps);
    const chunks: ScoredChunk[] = result.citations
      .map((id) => deps.retriever.byId(id))
      .filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk))
      .map((chunk) => ({ ...chunk, score: 1, lexical: 1, semantic: 1 }));

    rows.push({
      id: ticket.id,
      categoryOk: result.category === ticket.expectedCategory,
      priorityOk: result.priority === ticket.expectedPriority,
      retrievalHit: retrievalHit(chunks, ticket.expectedCategory),
      escalated: result.escalate,
      expectedEscalate: ticket.expectedEscalate,
      citationCovered: result.citations.length > 0,
    });
  }
  return buildReport(`agent (${deps.llm.name})`, rows, labels);
}

export function formatReport(report: EvalReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const failed = report.rows.filter((row) => !row.categoryOk || !row.priorityOk);
  const lines = [
    `### ${report.name}`,
    '',
    `| metric | value |`,
    `| --- | --- |`,
    `| tickets | ${report.total} |`,
    `| category accuracy | ${pct(report.categoryAccuracy)} |`,
    `| priority accuracy | ${pct(report.priorityAccuracy)} |`,
    `| exact match (category+priority) | ${pct(report.exactMatch)} |`,
    `| retrieval hit@3 | ${pct(report.retrievalHitRate)} |`,
    `| citation coverage | ${pct(report.citationCoverage)} |`,
    `| escalation precision | ${pct(report.escalationPrecision)} |`,
    `| escalation recall | ${pct(report.escalationRecall)} |`,
  ];
  if (failed.length) {
    lines.push('', 'Misses:', ...failed.map((row) => `- ${row.id}: category ${row.categoryOk ? 'ok' : 'WRONG'}, priority ${row.priorityOk ? 'ok' : 'WRONG'}`));
  }
  return lines.join('\n');
}
