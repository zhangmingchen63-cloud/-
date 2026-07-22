import type { Config, Context } from "@netlify/functions";
import { readState, writeState } from "./_shared/store";

function beijingTime(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export default async (_request: Request, context: Context) => {
  const state = await readState();
  const now = new Date();
  const currentTime = beijingTime(now);
  if (!state.settings.enabled || !state.settings.collection_times.includes(currentTime)) return;

  const webhook = Netlify.env.get("COLLECTOR_WEBHOOK_URL");
  const ingestKey = Netlify.env.get("INGEST_API_KEY");
  state.settings.last_run_at = now.toISOString();

  if (!webhook || !ingestKey) {
    state.settings.last_run_report = `已到 ${currentTime} 采集时段，但外部采集器尚未配置`;
    await writeState(state);
    return;
  }

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-key": ingestKey },
      body: JSON.stringify({
        requestedAt: now.toISOString(),
        lookbackHours: state.settings.lookback_hours,
        sources: state.sources.filter((source) => source.status === "enabled"),
        keywords: state.keywords.filter((keyword) => keyword.status === "enabled"),
        ingestUrl: `${context.site.url}/api/ingest/batch`,
      }),
    });
    state.settings.last_run_report = response.ok
      ? `${currentTime} 已触发采集器，等待结果写入`
      : `${currentTime} 采集器返回 ${response.status}`;
  } catch (error) {
    state.settings.last_run_report = `${currentTime} 采集器连接失败：${error instanceof Error ? error.message : "未知错误"}`;
  }
  await writeState(state);
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
