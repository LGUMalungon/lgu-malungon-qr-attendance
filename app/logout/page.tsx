"use client";

import { useEffect } from "react";
import { supabase } from "../lib/supabaseClient";

export default function LogoutPage() {
  useEffect(() => {
    (async () => {
      await supabase.auth.signOut();
      window.location.href = "/login";
    })();
  }, []);

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="card-title">Signing out…</div>
        <div className="card-subtitle">Please wait.</div>
      </div>
    </div>
  );
}
