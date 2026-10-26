import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Retriever } from './rag.ts';
import { createLlm } from './llm.ts';
import { triageTicket } from './agent.ts';
import { formatReport, loadEvalSet, runAgent, runBaseline } from './eval.ts';
import type { CustomerTier, Ticket } from './types.ts';

const ROOT = join(import.meta.dirname, '..');
const KB_DIR = join(ROOT, 'data', 'kb');
const EVAL_PATH = join(ROOT, 'data', 'eval', 'tickets.json');

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command = 'demo', ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, 'true');
    }
  }
  return { command, flags };
}

function hr(title: string): string {
  return `\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const retriever = await Retriever.load(KB_DIR);
  const llm = createLlm(config);
  const deps = { retriever, llm, config };

  console.log(`provider=${config.provider} llm=${llm.name} kb_chunks=${retriever.size} topK=${config.topK}`);

  if (command === 'eval') {
    const tickets = await loadEvalSet(EVAL_PATH);
    const baseline = await runBaseline(tickets);
    const agent = await runAgent(deps, tickets);
    console.log('\n' + formatReport(baseline));
    console.log('\n' + formatReport(agent));
    console.log(
      [
        '',
        '### delta',
        '',
        `- category accuracy: ${sign(agent.categoryAccuracy - baseline.categoryAccuracy)}`,
        `- priority accuracy: ${sign(agent.priorityAccuracy - baseline.priorityAccuracy)}`,
        `- exact match: ${sign(agent.exactMatch - baseline.exactMatch)}`,
        `- citation coverage: ${sign(agent.citationCoverage - baseline.citationCoverage)}`,
        `- escalation recall: ${sign(agent.escalationRecall - baseline.escalationRecall)}`,
        '',
      ].join('\n'),
    );
    return;
  }

  if (command === 'triage') {
    const text = flags.get('text');
    if (!text) {
      console.error('Usage: npm run triage -- --text "customer message" [--subject "..."] [--tier pro]');
      process.exitCode = 2;
      return;
    }
    const ticket: Ticket = {
      id: 'ADHOC-1',
      subject: flags.get('subject') ?? text.slice(0, 60),
      body: text,
      customerTier: (flags.get('tier') as CustomerTier) ?? 'pro',
    };
    printResult(await triageTicket(ticket, deps));
    return;
  }

  // demo: three tickets chosen to show the three interesting behaviours.
  const demo: Ticket[] = [
    {
      id: 'D-1',
      subject: 'Want to cancel and get a refund, still in trial window',
      body: 'We started 9 days ago and only used a small part of the quota. We would like to cancel and get our money back.',
      customerTier: 'free',
    },
    {
      id: 'D-2',
      subject: 'Unauthorized login from an unknown IP',
      body: 'We see a login from a country we do not operate in, and the user says they did not do it. This looks like account takeover.',
      customerTier: 'enterprise',
    },
    {
      id: 'D-3',
      subject: 'Can our team use this for something else entirely',
      body: 'We are a logistics company and wonder whether the product fits a warehouse workflow. Not sure this is the right place to ask.',
      customerTier: 'pro',
    },
  ];

  for (const ticket of demo) {
    printResult(await triageTicket(ticket, deps));
  }
}

function printResult(result: Awaited<ReturnType<typeof triageTicket>>): void {
  console.log(hr(`ticket ${result.ticketId}`));
  console.log(`triage      : ${result.category} / ${result.priority}  confidence=${result.confidence}`);
  console.log(`escalate    : ${result.escalate}${result.escalationReason ? ` (${result.escalationReason})` : ''}`);
  console.log(`citations   : ${result.citations.join(', ') || 'none'}`);
  console.log('trace       :');
  for (const step of result.trace) console.log(`  - ${step}`);
  console.log('draft       :');
  for (const line of result.draft.split('\n')) console.log(`  | ${line}`);
}

function sign(value: number): string {
  const pct = (value * 100).toFixed(1);
  return value >= 0 ? `+${pct} pts` : `${pct} pts`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
