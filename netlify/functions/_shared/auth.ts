import { getUser } from "@netlify/identity";

export async function requireMember() {
  const user = await getUser();
  if (!user?.email) {
    return { error: Response.json({ error: "请先登录工作台" }, { status: 401 }) } as const;
  }
  const allowed = (Netlify.env.get("ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(user.email.toLowerCase())) {
    return { error: Response.json({ error: "该邮箱不在成员白名单中" }, { status: 403 }) } as const;
  }
  return { user: { email: user.email } } as const;
}

export function requireIngestKey(request: Request) {
  const expected = Netlify.env.get("INGEST_API_KEY") ?? "";
  const supplied = request.headers.get("x-ingest-key") ?? "";
  if (!expected || supplied !== expected) {
    return Response.json({ error: "采集接口密钥不正确" }, { status: 401 });
  }
  return null;
}
