import { FormEvent, useEffect, useState } from "react";
import {
  AuthError,
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
} from "@netlify/identity";
import { IntelligenceDashboard } from "./Dashboard";
import type { WorkspaceUser } from "./types";

type AuthState = "loading" | "signed-out" | "signed-in" | "unavailable";

function toWorkspaceUser(user: { email?: string | null; name?: string | null }): WorkspaceUser {
  const email = user.email ?? "";
  return { email, name: user.name?.trim() || email.split("@")[0] || "审核成员" };
}

export function App() {
  const [state, setState] = useState<AuthState>("loading");
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await handleAuthCallback();
        const current = await getUser();
        if (!active) return;
        if (current) {
          setUser(toWorkspaceUser(current));
          setState("signed-in");
        } else {
          setState("signed-out");
        }
      } catch {
        if (active) setState("unavailable");
      }
    })();
    const unsubscribe = onAuthChange((_event, current) => {
      if (!active) return;
      setUser(current ? toWorkspaceUser(current) : null);
      setState(current ? "signed-in" : "signed-out");
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    try {
      const current = await login(email.trim(), password);
      setUser(toWorkspaceUser(current));
      setState("signed-in");
    } catch (error) {
      setMessage(error instanceof AuthError ? error.message : "登录失败，请检查邮箱和密码。");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return <main className="auth-screen"><div className="auth-loader" /><p>正在连接情报工作台…</p></main>;
  }

  if (state === "unavailable") {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <div className="auth-brand"><span>中俄</span><div><strong>老丁中俄贸易情报</strong><small>NETLIFY BACKUP</small></div></div>
          <h1>登录服务尚未启用</h1>
          <p>网站已部署，但需要在 Netlify 项目配置中启用 Identity，并把注册方式设为“仅邀请”。</p>
          <button type="button" onClick={() => window.location.reload()}>重新检测</button>
        </section>
      </main>
    );
  }

  if (!user || state === "signed-out") {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <div className="auth-brand"><span>中俄</span><div><strong>老丁中俄贸易情报</strong><small>INTELLIGENCE DESK</small></div></div>
          <div className="auth-pulse"><i /><span>仅限邮箱白名单成员</span></div>
          <h1>进入每日情报审核台</h1>
          <p>集中核验政策、清关、物流、平台和税务信息。所有审核操作都会留下记录。</p>
          <form onSubmit={submitLogin}>
            <label><span>邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
            <label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
            {message && <div className="auth-error">{message}</div>}
            <button type="submit" disabled={submitting}>{submitting ? "正在登录…" : "登录工作台"}</button>
          </form>
          <small className="auth-note">未收到邀请的邮箱无法创建账号。</small>
        </section>
      </main>
    );
  }

  return <IntelligenceDashboard user={user} onLogout={() => void logout()} />;
}
