export type Category = 'billing' | 'refund' | 'account' | 'api' | 'other';

export type Priority = 'P1' | 'P2' | 'P3';

export type CustomerTier = 'free' | 'pro' | 'enterprise';

export interface Ticket {
  id: string;
  subject: string;
  body: string;
  customerTier: CustomerTier;
}

export interface KbChunk {
  id: string;
  docId: string;
  docTitle: string;
  heading: string;
  text: string;
}

export interface ScoredChunk extends KbChunk {
  score: number;
  lexical: number;
  semantic: number;
}

export interface SlaPolicy {
  tier: CustomerTier;
  firstResponse: string;
  resolutionTarget: string;
  onCall: boolean;
}

export interface Classification {
  category: Category;
  priority: Priority;
  confidence: number;
  rationale: string;
}

export interface TriageResult {
  ticketId: string;
  category: Category;
  priority: Priority;
  confidence: number;
  escalate: boolean;
  escalationReason?: string;
  citations: string[];
  draft: string;
  trace: string[];
}

export interface LabeledTicket extends Ticket {
  expectedCategory: Category;
  expectedPriority: Priority;
  expectedEscalate: boolean;
}

export interface EvalRow {
  id: string;
  categoryOk: boolean;
  priorityOk: boolean;
  retrievalHit: boolean;
  escalated: boolean;
  expectedEscalate: boolean;
  citationCovered: boolean;
}

export interface EvalReport {
  name: string;
  total: number;
  categoryAccuracy: number;
  priorityAccuracy: number;
  exactMatch: number;
  retrievalHitRate: number;
  escalationPrecision: number;
  escalationRecall: number;
  citationCoverage: number;
  rows: EvalRow[];
}
