import type { Config, Context } from "@netlify/functions";
import * as XLSX from "xlsx";
import { requireIngestKey, requireMember } from "./_shared/auth";
import {
  normalizeTitle,
  readState,
  recordWithQueue,
  writeState,
  type IntelligenceRecord,
  type ReviewStatus,
  type SourceRecord,
} from "./_shared/store";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const allowedReviewStatuses = new Set<ReviewStatus>(["verified", "held", "rejected"]);
const allowedGrades = new Set(["S", "A", "B", "C"]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clampScore(value: unknown, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.round(number))) : 0;
}

function sourcePayload(payload: Record<string, unknown>): Omit<SourceRecord, "id" | "last_checked_at"> {
  return {
    name: cleanText(payload.name),
    region: cleanText(payload.region),
    direction: cleanText(payload.direction),
    grade: cleanText(payload.grade).toUpperCase(),
    language: cleanText(payload.language),
    url: cleanText(payload.url),
    frequency: cleanText(payload.frequency),
    focus: cleanText(payload.focus),
    usage_note: cleanText(payload.usageNote ?? payload.usage_note),
    status: payload.status === "disabled" ? "disabled" : "enabled",
  };
}

function filteredIntelligence(state: Awaited<ReturnType<typeof readState>>, url: URL) {
  const search = cleanText(url.searchParams.get("search")).toLowerCase();
  const status = cleanText(url.searchParams.get("status"));
  const direction = cleanText(url.searchParams.get("direction"));
  const grade = cleanText(url.searchParams.get("grade"));
  const risk = cleanText(url.searchParams.get("risk"));
  const from = cleanText(url.searchParams.get("from"));
  const to = cleanText(url.searchParams.get("to"));
  const minScore = Number(url.searchParams.get("minScore") ?? 0);
  const queueOnly = url.searchParams.get("queue") === "1";
  return state.intelligence
    .filter((item) => !search || `${item.title} ${item.summary} ${item.source_name}`.toLowerCase().includes(search))
    .filter((item) => !status || item.review_status === status)
    .filter((item) => !direction || item.direction === direction)
    .filter((item) => !grade || item.source_grade === grade)
    .filter((item) => !risk || item.risk_level === risk)
    .filter((item) => !from || item.collected_at >= from)
    .filter((item) => !to || item.collected_at <= to)
    .filter((item) => !Number.isFinite(minScore) || item.total_score >= minScore)
    .filter((item) => !queueOnly || state.queue.some((entry) => entry.intelligence_id === item.id))
    .sort((a, b) => b.total_score - a.total_score || (b.published_at ?? "").localeCompare(a.published_at ?? ""));
}

async function handleIntelligence(request: Request, url: URL) {
  const state = await readState();
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50)));
  const filtered = filteredIntelligence(state, url);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const summary = {
    total: state.intelligence.length,
    today: state.intelligence.filter((item) => item.collected_at === today).length,
    pending: state.intelligence.filter((item) => item.review_status === "pending").length,
    high_score: state.intelligence.filter((item) => item.total_score >= 80).length,
    red_risk: state.intelligence.filter((item) => item.risk_level === "红色").length,
    queue_count: state.queue.length,
  };
  const categoryMap = new Map<string, number>();
  state.intelligence.forEach((item) => categoryMap.set(item.direction, (categoryMap.get(item.direction) ?? 0) + 1));
  const categories = [...categoryMap.entries()]
    .map(([direction, count]) => ({ direction, count }))
    .sort((a, b) => b.count - a.count);
  const start = (page - 1) * pageSize;
  return json({
    items: filtered.slice(start, start + pageSize).map((item) => recordWithQueue(state, item)),
    total: filtered.length,
    page,
    pageSize,
    summary,
    categories,
  });
}

async function handleReview(request: Request, id: string, reviewerEmail: string) {
  const payload = await request.json() as Record<string, unknown>;
  const status = cleanText(payload.status) as ReviewStatus;
  const note = cleanText(payload.note);
  if (!allowedReviewStatuses.has(status)) return json({ error: "审核状态不正确" }, 400);
  if (!note) return json({ error: "请填写或保留核验备注" }, 400);
  const state = await readState();
  const item = state.intelligence.find((record) => record.id === id);
  if (!item) return json({ error: "情报不存在" }, 404);
  const previous = item.review_status;
  item.review_status = status;
  item.review_note = note;
  item.worth_writing = status === "verified" ? "ready" : "pending";
  item.updated_at = new Date().toISOString();
  if (status !== "verified") state.queue = state.queue.filter((entry) => entry.intelligence_id !== id);
  state.review_events.unshift({
    id: crypto.randomUUID(),
    intelligence_id: id,
    previous_status: previous,
    next_status: status,
    note,
    reviewer_email: reviewerEmail,
    reviewed_at: new Date().toISOString(),
  });
  await writeState(state);
  return json({ item: recordWithQueue(state, item) });
}

async function handleQueue(request: Request, id: string, memberEmail: string) {
  const state = await readState();
  const item = state.intelligence.find((record) => record.id === id);
  if (!item) return json({ error: "情报不存在" }, 404);
  if (request.method === "DELETE") {
    state.queue = state.queue.filter((entry) => entry.intelligence_id !== id);
    await writeState(state);
    return json({ ok: true, inQueue: false });
  }
  if (item.review_status !== "verified" || item.total_score < 65) {
    return json({ error: "只有已确认且65分以上的情报可以加入待写稿" }, 400);
  }
  if (!state.queue.some((entry) => entry.intelligence_id === id)) {
    state.queue.push({ intelligence_id: id, added_by: memberEmail, added_at: new Date().toISOString() });
    await writeState(state);
  }
  return json({ ok: true, inQueue: true });
}

async function handleSources(request: Request, id?: string) {
  const state = await readState();
  if (request.method === "GET") {
    return json({ items: [...state.sources].sort((a, b) => "SABC".indexOf(a.grade) - "SABC".indexOf(b.grade)) });
  }
  const payload = sourcePayload(await request.json() as Record<string, unknown>);
  if (!payload.name || !payload.region || !payload.direction || !payload.language || !payload.url || !payload.frequency) {
    return json({ error: "请完整填写名称、地区、方向、语言、网址和采集频率" }, 400);
  }
  if (!allowedGrades.has(payload.grade)) return json({ error: "来源等级不正确" }, 400);
  if (id) {
    const index = state.sources.findIndex((source) => source.id === id);
    if (index < 0) return json({ error: "信息源不存在" }, 404);
    state.sources[index] = { ...state.sources[index], ...payload };
    await writeState(state);
    return json({ item: state.sources[index] });
  }
  if (state.sources.some((source) => source.url === payload.url)) return json({ error: "该信息源网址已经存在" }, 409);
  const item: SourceRecord = { ...payload, id: `SRC-${crypto.randomUUID().slice(0, 8)}`, last_checked_at: null };
  state.sources.push(item);
  await writeState(state);
  return json({ item }, 201);
}

async function handleSettings(request: Request) {
  const state = await readState();
  if (request.method === "GET") return json({ settings: state.settings });
  const payload = await request.json() as Record<string, unknown>;
  const times = Array.isArray(payload.collectionTimes) ? payload.collectionTimes.map(cleanText) : [];
  if (times.length !== 2 || times.some((time) => !/^([01]\d|2[0-3]):(00|15|30|45)$/.test(time))) {
    return json({ error: "请设置两个不同的北京时间，分钟需为00、15、30或45" }, 400);
  }
  if (times[0] === times[1]) return json({ error: "两个采集时间不能相同" }, 400);
  state.settings.collection_times = [times[0], times[1]];
  state.settings.lookback_hours = Math.max(1, Math.min(72, Number(payload.lookbackHours) || 24));
  state.settings.enabled = payload.enabled !== false;
  await writeState(state);
  return json({ settings: state.settings });
}

async function handleIngest(request: Request) {
  const keyError = requireIngestKey(request);
  if (keyError) return keyError;
  const payload = await request.json() as { items?: Array<Record<string, unknown>>; scanned?: number };
  const incoming = Array.isArray(payload.items) ? payload.items : [];
  const state = await readState();
  let added = 0;
  for (const raw of incoming) {
    const title = cleanText(raw.title);
    const sourceUrl = cleanText(raw.sourceUrl ?? raw.source_url);
    const eventHash = cleanText(raw.eventHash ?? raw.event_hash) || normalizeTitle(`${title}-${sourceUrl}`);
    const normalized = normalizeTitle(title);
    if (!title || !sourceUrl) continue;
    if (state.intelligence.some((item) => item.source_url === sourceUrl || item.normalized_title === normalized || item.event_hash === eventHash)) continue;
    const now = new Date().toISOString();
    const grade = cleanText(raw.sourceGrade ?? raw.source_grade).toUpperCase() || "C";
    const direction = cleanText(raw.direction) || "市场动态";
    const sensitive = /清关|税务|制裁|支付|平台规则/.test(`${direction} ${title}`);
    const scores = {
      relevance: clampScore(raw.relevanceScore ?? raw.relevance_score, 25),
      impact: clampScore(raw.impactScore ?? raw.impact_score, 20),
      urgency: clampScore(raw.urgencyScore ?? raw.urgency_score, 15),
      trust: clampScore(raw.sourceTrustScore ?? raw.source_trust_score, 15),
      solvability: clampScore(raw.solvabilityScore ?? raw.solvability_score, 15),
      conversion: clampScore(raw.conversionScore ?? raw.conversion_score, 10),
    };
    const total = Object.values(scores).reduce((sum, score) => sum + score, 0);
    const item: IntelligenceRecord = {
      id: cleanText(raw.id) || `I-${Date.now()}-${String(added + 1).padStart(3, "0")}`,
      collected_at: cleanText(raw.collectedAt ?? raw.collected_at) || now.slice(0, 10),
      published_at: cleanText(raw.publishedAt ?? raw.published_at) || null,
      title,
      normalized_title: normalized,
      summary: cleanText(raw.summary) || "等待人工补充中文摘要。",
      source_name: cleanText(raw.sourceName ?? raw.source_name) || "自动采集",
      source_grade: grade,
      source_url: sourceUrl,
      backup_url: cleanText(raw.backupUrl ?? raw.backup_url) || null,
      region: cleanText(raw.region) || "俄罗斯",
      direction,
      target_customers: cleanText(raw.targetCustomers ?? raw.target_customers) || "待判断",
      impact_type: cleanText(raw.impactType ?? raw.impact_type) || "线索",
      effective_date: cleanText(raw.effectiveDate ?? raw.effective_date) || null,
      review_date: cleanText(raw.reviewDate ?? raw.review_date) || null,
      relevance_score: scores.relevance,
      impact_score: scores.impact,
      urgency_score: scores.urgency,
      source_trust_score: scores.trust,
      solvability_score: scores.solvability,
      conversion_score: scores.conversion,
      total_score: total,
      handling_level: total >= 90 ? "紧急加工" : total >= 75 ? "重点稿件" : total >= 50 ? "观察选题" : "资料归档",
      risk_level: cleanText(raw.riskLevel ?? raw.risk_level) || (total >= 90 ? "红色" : total >= 75 ? "橙色" : total >= 50 ? "黄色" : "绿色"),
      review_status: "pending",
      review_note: cleanText(raw.reviewNote ?? raw.review_note) || "自动采集写入，等待人工核验来源、日期和适用范围。",
      worth_writing: "pending",
      info_status: sensitive && !["S", "A"].includes(grade) ? "线索" : "new",
      event_hash: eventHash,
      created_at: now,
      updated_at: now,
    };
    state.intelligence.push(item);
    added += 1;
  }
  await writeState(state);
  const top = [...state.intelligence].sort((a, b) => b.total_score - a.total_score).slice(0, 3).map((item) => ({ id: item.id, title: item.title, score: item.total_score }));
  return json({ scanned: Number(payload.scanned) || incoming.length, added, top });
}

async function handleExport(url: URL) {
  const state = await readState();
  const ids = new Set(cleanText(url.searchParams.get("ids")).split(",").filter(Boolean));
  const intelligence = state.intelligence
    .filter((item) => !ids.size || ids.has(item.id))
    .map((item) => ({ ...recordWithQueue(state, item), in_queue: item.review_status === "verified" && state.queue.some((entry) => entry.intelligence_id === item.id) ? "是" : "否" }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(intelligence), "情报");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(state.sources), "信息源");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(state.keywords), "关键词");
  const body = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
  return new Response(body.buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="laoding-intelligence-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/ingest/batch" && request.method === "POST") return handleIngest(request);

  const auth = await requireMember();
  if ("error" in auth) return auth.error;

  if (path === "/api/intelligence" && request.method === "GET") return handleIntelligence(request, url);
  if (path === "/api/sources") return handleSources(request);
  if (path === "/api/settings") return handleSettings(request);
  if (path === "/api/export" && request.method === "GET") return handleExport(url);
  if (path === "/api/collector-config" && request.method === "GET") {
    const state = await readState();
    return json({ sources: state.sources.filter((source) => source.status === "enabled"), keywords: state.keywords.filter((keyword) => keyword.status === "enabled"), settings: state.settings });
  }

  const sourceMatch = path.match(/^\/api\/sources\/([^/]+)$/);
  if (sourceMatch) return handleSources(request, decodeURIComponent(sourceMatch[1]));

  const reviewMatch = path.match(/^\/api\/intelligence\/([^/]+)\/review$/);
  if (reviewMatch && request.method === "PATCH") return handleReview(request, decodeURIComponent(reviewMatch[1]), auth.user.email);

  const linkMatch = path.match(/^\/api\/intelligence\/([^/]+)\/link$/);
  if (linkMatch && request.method === "PATCH") {
    const state = await readState();
    const item = state.intelligence.find((record) => record.id === decodeURIComponent(linkMatch[1]));
    if (!item) return json({ error: "情报不存在" }, 404);
    const payload = await request.json() as Record<string, unknown>;
    item.backup_url = cleanText(payload.backupUrl) || null;
    item.updated_at = new Date().toISOString();
    await writeState(state);
    return json({ item: recordWithQueue(state, item) });
  }

  const queueMatch = path.match(/^\/api\/script-queue\/([^/]+)$/);
  if (queueMatch && ["POST", "DELETE"].includes(request.method)) return handleQueue(request, decodeURIComponent(queueMatch[1]), auth.user.email);

  const detailMatch = path.match(/^\/api\/intelligence\/([^/]+)$/);
  if (detailMatch && request.method === "GET") {
    const state = await readState();
    const item = state.intelligence.find((record) => record.id === decodeURIComponent(detailMatch[1]));
    return item ? json({ item: recordWithQueue(state, item) }) : json({ error: "情报不存在" }, 404);
  }

  return json({ error: "接口不存在" }, 404);
};

export const config: Config = {
  path: [
    "/api/intelligence",
    "/api/intelligence/:id",
    "/api/intelligence/:id/review",
    "/api/intelligence/:id/link",
    "/api/script-queue/:id",
    "/api/sources",
    "/api/sources/:id",
    "/api/settings",
    "/api/collector-config",
    "/api/ingest/batch",
    "/api/export",
  ],
};
