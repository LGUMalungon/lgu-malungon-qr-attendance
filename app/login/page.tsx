"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type Role = "app_master" | "hr_admin" | "hr_scanner";

function getRoleFromSession(session: any): Role | "" {
  return (session?.user?.user_metadata?.role ?? "") as Role | "";
}

function goByRole(role: Role | "") {
  if (role === "hr_scanner") {
    window.location.href = "/scanner";
    return;
  }
  if (role === "hr_admin" || role === "app_master") {
    window.location.href = "/dashboard";
    return;
  }
  // unknown role -> safest: logout then login again
  window.location.href = "/logout";
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        const role = getRoleFromSession(data.session);
        goByRole(role);
      }
    });
  }, []);

  async function signIn() {
    setMsg(null);
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setMsg(error.message);
        return;
      }

      const role = getRoleFromSession(data.session);
      goByRole(role);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="card-title">Login</div>
        <div className="card-subtitle">
          Authorized users only. Please sign in.
        </div>

        <div className="field">
          <label className="label">Email</label>
          <input
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@malungon.gov.ph"
            autoComplete="email"
          />
        </div>

        <div className="field">
          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            onKeyDown={(e) => {
              if (e.key === "Enter") signIn();
            }}
          />
        </div>

        {msg && <div className="auth-error">{msg}</div>}

        <div style={{ height: 12 }} />

        <button className="btn btn-orange" onClick={signIn} disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </div>
    </div>
  );
}
