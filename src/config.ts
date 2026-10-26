export type LlmProvider = 'mock' | 'openai';

export interface AppConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  topK: number;
  escalationConfidence: number;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  const provider = (process.env.LLM_PROVIDER ?? 'mock').toLowerCase();
  return {
    provider: provider === 'openai' ? 'openai' : 'mock',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    topK: num(process.env.TOP_K, 4),
    escalationConfidence: num(process.env.ESCALATION_CONFIDENCE, 0.55),
  };
}

export const CATEGORIES = ['billing', 'refund', 'account', 'api', 'other'] as const;
export const PRIORITIES = ['P1', 'P2', 'P3'] as const;
