import type {
  Category,
  Classification,
  CustomerTier,
  Priority,
  ScoredChunk,
  SlaPolicy,
  Ticket,
} from './types.ts';
import type { AppConfig } from './config.ts';

export interface ClassifyInput {
  ticket: Ticket;
  chunks: ScoredChunk[];
  sla: SlaPolicy;
}

export interface DraftInput extends ClassifyInput {
  classification: Classification;
}

export interface Llm {
  readonly name: string;
  classify(input: ClassifyInput): Promise<Classification>;
  draft(input: DraftInput): Promise<string>;
}

const CATEGORY_KEYWORDS: Record<Exclude<Category, 'other'>, string[]> = {
  billing: [
    'invoice', 'charged', 'charges', 'chargeback invoice', 'payment', 'paid', 'billing', 'card',
    'dunning', 'prorate', 'prorated', 'upgrade', 'downgrade', 'seats', 'tax', 'vat', 'duplicate',
    'declined', 'receipt', 'entity name',
  ],
  refund: [
    'refund', 'money back', 'cancel', 'cancellation', 'trial', 'credit', 'chargeback', 'reimburse',
    'annual plan', 'monthly plan', 'goodwill', 'prorated refund',
  ],
  account: [
    'login', 'log in', 'password', 'locked', 'lock', '2fa', 'two-factor', 'sso', 'saml', 'oidc',
    'owner', 'ownership', 'member', 'members', 'delete', 'deletion', 'export', 'recovery code',
    'unauthorized', 'hacked', 'takeover', 'suspicious',
  ],
  api: [
    'api', 'endpoint', 'key', 'token', '429', 'rate limit', 'ratelimit', 'webhook', 'sandbox',
    'error code', '500', '502', '401', '403', 'retry-after', 'integration', 'sdk',
  ],
};

const DOC_TO_CATEGORY: Record<string, Category> = {
  billing: 'billing',
  refunds: 'refund',
  account: 'account',
  api: 'api',
  sla: 'other',
};

const P1_PATTERNS = [
  'cannot log in', "can't log in", 'unable to log in', 'no access at all', 'completely down',
  'full outage', 'production is down', 'outage', 'data loss', 'lost data', 'security incident',
  'hacked', 'unauthorized access', 'account takeover', 'breach', 'everyone is blocked',
  'all users affected', 'cannot use the product',
];

const P2_PATTERNS = [
  'not working', "doesn't work", 'does not work', 'fails', 'failing', 'failed', 'blocked',
  'broken', 'error 5', 'chargeback', 'suspended', 'locked out', 'cannot export', 'urgent',
  '429', 'declined', 'duplicate', 'expired', 'downgrad', 'throttl', 'leaked', 'screenshot',
  'shared the key', 'shared a key',
];

/**
 * Word-boundary matching. Substring matching produced false positives such as
 * "accounting" matching the keyword "account", which misrouted invoice tickets.
 * Multi-word needles still use substring matching because they contain spaces.
 */
function countMatches(haystack: string, needles: string[]): number {
  const words = new Set(haystack.split(/[^a-z0-9-]+/).filter(Boolean));
  let score = 0;
  for (const needle of needles) {
    if (needle.includes(' ')) {
      if (haystack.includes(needle)) score += 2;
    } else if (words.has(needle)) {
      score += 1;
    }
  }
  return score;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Deterministic, dependency-free triage engine.
 * This is the offline path: it makes the repository runnable with no API key and
 * doubles as the rule-based baseline the LLM implementation is measured against.
 */
export class MockLlm implements Llm {
  readonly name = 'mock-heuristic';

  async classify({ ticket, chunks, sla }: ClassifyInput): Promise<Classification> {
    const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
    const scores = new Map<Category, number>();

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      scores.set(category as Category, countMatches(text, keywords));
    }

    // Retrieved context nudges the prior: documents matched by retrieval are evidence,
    // but they must never outvote an explicit keyword hit, so the boost is capped.
    for (const chunk of chunks) {
      const category = DOC_TO_CATEGORY[chunk.docId];
      if (!category || category === 'other') continue;
      scores.set(category, (scores.get(category) ?? 0) + 0.7 * Math.min(chunk.score, 1));
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const [topCategory, topScore] = ranked[0];
    const secondScore = ranked[1]?.[1] ?? 0;
    const category: Category = topScore < 1.0 ? 'other' : topCategory;

    let priority: Priority = 'P3';
    if (countMatches(text, P1_PATTERNS) > 0) {
      priority = 'P1';
    } else if (countMatches(text, P2_PATTERNS) > 0) {
      priority = 'P2';
    }
    if (ticket.customerTier === 'enterprise' && priority === 'P3' && /cannot|blocked|down/.test(text)) {
      priority = 'P2';
    }

    const retrievalSignal = Math.min(1, (chunks[0]?.score ?? 0) / 1.2);
    const margin = topScore > 0 ? (topScore - secondScore) / topScore : 0;
    let confidence = 0.3 + 0.4 * margin + 0.3 * retrievalSignal;
    if (category === 'other') confidence = Math.min(confidence, 0.5);
    if (priority === 'P1') confidence = Math.max(confidence, 0.7);

    const rationale = [
      `category score ${round(topScore)} vs runner-up ${round(secondScore)}`,
      `retrieval top score ${round(chunks[0]?.score ?? 0)}`,
      `priority matched ${priority} patterns`,
      `sla first response for ${sla.tier}: ${sla.firstResponse}`,
    ].join('; ');

    return { category, priority, confidence: round(Math.min(0.97, confidence)), rationale };
  }

  async draft({ ticket, chunks, classification }: DraftInput): Promise<string> {
    const refs = chunks.slice(0, 2);
    const citations = refs.map((chunk) => `[${chunk.id}]`).join(' ');
    const talkingPoints = refs
      .map((chunk) => `- ${chunk.heading}: ${firstSentence(chunk.text)}`)
      .join('\n');

    return [
      `Hi ${nameFrom(ticket)},`,
      '',
      `Thanks for reaching out. Based on your message I understand this is a ${classification.category} question at ${classification.priority} priority.`,
      '',
      talkingPoints,
      '',
      `Next step: ${nextStep(classification)}`,
      '',
      `Sources: ${citations}`,
      '',
      'If this does not resolve it, reply here and a specialist will take over.',
    ].join('\n');
  }
}

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = /^.{0,180}?[.!?](\s|$)/.exec(clean);
  return (match ? match[0] : `${clean.slice(0, 160)}…`).trim();
}

function nameFrom(ticket: Ticket): string {
  return ticket.customerTier === 'enterprise' ? 'team' : 'there';
}

function nextStep(classification: Classification): string {
  if (classification.priority === 'P1') return 'we have paged the on-call engineer and will update you within the SLA window.';
  if (classification.category === 'refund') return 'we are checking your plan and charge dates against the refund policy.';
  if (classification.category === 'billing') return 'we are pulling the invoice and payment history for your workspace.';
  if (classification.category === 'api') return 'please share the request id and timestamp so we can trace the call.';
  return 'we are confirming the details with the account owner on record.';
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export class OpenAiLlm implements Llm {
  readonly name: string;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.name = `${config.model} @ ${config.baseUrl}`;
  }

  private async complete(messages: ChatMessage[], jsonMode: boolean): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('LLM_API_KEY is not set. Unset LLM_PROVIDER to use the offline baseline.');
    }
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        messages,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content?.trim() ?? '';
  }

  async classify({ ticket, chunks, sla }: ClassifyInput): Promise<Classification> {
    const context = chunks
      .map((chunk) => `[${chunk.id}] (${chunk.docTitle} / ${chunk.heading})\n${chunk.text}`)
      .join('\n\n');

    const system: ChatMessage = {
      role: 'system',
      content: [
        'You triage B2B SaaS support tickets.',
        'Return JSON with keys: category (billing|refund|account|api|other), priority (P1|P2|P3),',
        'confidence (0-1), rationale (one sentence).',
        'Use only the SLA definitions and knowledge base excerpts provided. If the excerpts do not',
        'support a decision, set category to "other" and confidence below 0.5.',
        'Never invent a policy number or a commitment the excerpts do not contain.',
      ].join(' '),
    };
    const user: ChatMessage = {
      role: 'user',
      content: [
        `Customer tier: ${ticket.customerTier}`,
        `SLA first response: ${sla.firstResponse}; resolution target: ${sla.resolutionTarget}`,
        '',
        `Subject: ${ticket.subject}`,
        `Body: ${ticket.body}`,
        '',
        'Knowledge base excerpts:',
        context,
      ].join('\n'),
    };

    const raw = await this.complete([system, user], true);
    return parseClassification(raw);
  }

  async draft({ ticket, chunks, classification }: DraftInput): Promise<string> {
    const context = chunks
      .map((chunk) => `[${chunk.id}] (${chunk.docTitle} / ${chunk.heading})\n${chunk.text}`)
      .join('\n\n');
    const system: ChatMessage = {
      role: 'system',
      content: [
        'You write first-response support replies.',
        'Every factual claim must be supported by a cited excerpt, in square brackets like [doc#section].',
        'Keep it under 160 words. Plain English, no marketing tone.',
        'Do not promise refunds, roadmap dates, or anything outside the excerpts.',
      ].join(' '),
    };
    const user: ChatMessage = {
      role: 'user',
      content: [
        `Subject: ${ticket.subject}`,
        `Body: ${ticket.body}`,
        `Triage: category=${classification.category} priority=${classification.priority}`,
        '',
        'Excerpts:',
        context,
      ].join('\n'),
    };
    return this.complete([system, user], false);
  }
}

export function parseClassification(raw: string): Classification {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) throw new Error(`Could not parse classification JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]) as Partial<Classification>;
  const category = (parsed.category ?? 'other') as Category;
  const priority = (parsed.priority ?? 'P3') as Priority;
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.4;
  return {
    category,
    priority,
    confidence: Math.max(0, Math.min(1, confidence)),
    rationale: parsed.rationale ?? 'no rationale returned',
  };
}

export function createLlm(config: AppConfig): Llm {
  return config.provider === 'openai' ? new OpenAiLlm(config) : new MockLlm();
}

export function slaFor(tier: CustomerTier): SlaPolicy {
  const table: Record<CustomerTier, SlaPolicy> = {
    free: { tier: 'free', firstResponse: '24 hours (P1)', resolutionTarget: 'best effort', onCall: false },
    pro: { tier: 'pro', firstResponse: '8 business hours (P1)', resolutionTarget: '2 business days', onCall: false },
    enterprise: {
      tier: 'enterprise',
      firstResponse: '1 hour (P1, on-call paging)',
      resolutionTarget: '4 business hours',
      onCall: true,
    },
  };
  return table[tier];
}
