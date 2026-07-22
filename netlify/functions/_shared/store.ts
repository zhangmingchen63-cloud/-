import { getDeployStore, getStore } from "@netlify/blobs";
import { seedIntelligence, seedKeywords, seedSources } from "./seed-data";

export type ReviewStatus = "pending" | "verified" | "held" | "rejected";

export type IntelligenceRecord = {
  id: string;
  collected_at: string;
  published_at: string | null;
  title: string;
  normalized_title: string;
  summary: string;
  source_name: string;
  source_grade: string;
  source_url: string;
  backup_url: string | null;
  region: string;
  direction: string;
  target_customers: string;
  impact_type: string;
  effective_date: string | null;
  review_date: string | null;
  relevance_score: number;
  impact_score: number;
  urgency_score: number;
  source_trust_score: number;
  solvability_score: number;
  conversion_score: number;
  total_score: number;
  handling_level: string;
  risk_level: string;
  review_status: ReviewStatus;
  review_note: string;
  worth_writing: string;
  info_status: string;
  event_hash: string;
  created_at: string;
  updated_at: string;
};

export type SourceRecord = {
  id: string;
  name: string;
  region: string;
  direction: string;
  grade: string;
  language: string;
  url: string;
  frequency: string;
  focus: string;
  usage_note: string;
  status: "enabled" | "disabled";
  last_checked_at: string | null;
};

export type WorkspaceState = {
  version: 1;
  intelligence: IntelligenceRecord[];
  sources: SourceRecord[];
  keywords: Array<Record<string, string>>;
  queue: Array<{ intelligence_id: string; added_by: string; added_at: string }>;
  review_events: Array<{
    id: string;
    intelligence_id: string;
    previous_status: ReviewStatus;
    next_status: ReviewStatus;
    note: string;
    reviewer_email: string;
    reviewed_at: string;
  }>;
  settings: {
    timezone: "Asia/Shanghai";
    collection_times: [string, string];
    lookback_hours: number;
    enabled: boolean;
    last_run_at: string | null;
    last_run_report: string;
  };
};

const STATE_KEY = "workspace-state-v1";

function normalizeTitle(title: string) {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 160);
}

function createSeedState(): WorkspaceState {
  const now = new Date().toISOString();
  return {
    version: 1,
    intelligence: seedIntelligence.map((item, index) => ({
      id: item.id,
      collected_at: item.collectedAt,
      published_at: item.publishedAt || null,
      title: item.title,
      normalized_title: normalizeTitle(item.title),
      summary: item.summary,
      source_name: item.sourceName,
      source_grade: item.sourceGrade,
      source_url: item.sourceUrl,
      backup_url: null,
      region: item.region,
      direction: item.direction,
      target_customers: item.targetCustomers,
      impact_type: item.impactType,
      effective_date: item.effectiveDate || null,
      review_date: item.reviewDate || null,
      relevance_score: item.relevanceScore,
      impact_score: item.impactScore,
      urgency_score: item.urgencyScore,
      source_trust_score: item.sourceTrustScore,
      solvability_score: item.solvabilityScore,
      conversion_score: item.conversionScore,
      total_score: item.totalScore,
      handling_level: item.handlingLevel,
      risk_level: item.riskLevel,
      review_status: index === 0 ? "verified" : "pending",
      review_note: item.reviewNote,
      worth_writing: index === 0 ? "ready" : "pending",
      info_status: "seed",
      event_hash: item.eventHash,
      created_at: now,
      updated_at: now,
    })),
    sources: seedSources.map((source) => ({
      id: source.id,
      name: source.name,
      region: source.region,
      direction: source.direction,
      grade: source.grade,
      language: source.language,
      url: source.url,
      frequency: source.frequency,
      focus: source.focus,
      usage_note: source.usageNote,
      status: "enabled",
      last_checked_at: null,
    })),
    keywords: seedKeywords.map((keyword) => ({
      id: keyword.id,
      topic: keyword.topic,
      chinese: keyword.chinese,
      russian: keyword.russian,
      risk_trigger: keyword.riskTrigger,
      target_customers: keyword.targetCustomers,
      suggested_combination: keyword.suggestedCombination,
      note: keyword.note,
      status: "enabled",
    })),
    queue: [],
    review_events: [],
    settings: {
      timezone: "Asia/Shanghai",
      collection_times: ["08:30", "17:30"],
      lookback_hours: 24,
      enabled: true,
      last_run_at: null,
      last_run_report: "尚未运行",
    },
  };
}

function stateStore() {
  const isProduction = Netlify.context?.deploy?.context === "production";
  return isProduction
    ? getStore("laoding-intelligence", { consistency: "strong" })
    : getDeployStore("laoding-intelligence", { consistency: "strong" });
}

export async function readState(): Promise<WorkspaceState> {
  const store = stateStore();
  const existing = await store.get(STATE_KEY, { type: "json" }) as WorkspaceState | null;
  if (existing) return existing;
  const state = createSeedState();
  await store.setJSON(STATE_KEY, state);
  return state;
}

export async function writeState(state: WorkspaceState) {
  await stateStore().setJSON(STATE_KEY, state);
}

export function recordWithQueue(state: WorkspaceState, item: IntelligenceRecord) {
  return {
    ...item,
    in_queue: state.queue.some((entry) => entry.intelligence_id === item.id) ? 1 : 0,
  };
}

export { normalizeTitle };
