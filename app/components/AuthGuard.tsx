"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type Role = "app_master" | "hr_admin" | "hr_scanner";

function getRole(session: any): Role | "" {
  return (session?.user?.user_metadata?.role ?? "") as Role | "";
}

export function AuthGuard({
  allowRoles,
  children,
}: {
  allowRoles: Role[];
  children: React.ReactNode;
}) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function check() {
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      // Not logged in -> login page
      if (!session) {
        window.location.href = "/login";
        return;
      }

      const role = getRole(session);

      // Logged in but role missing/unknown -> force logout for safety
      if (!role) {
        window.location.href = "/logout";
        return;
      }

      // Role not allowed -> redirect to correct home
      if (!allowRoles.includes(role)) {
        if (role === "hr_scanner") window.location.href = "/scanner";
        else window.location.href = "/dashboard";
        return;
      }

      if (mounted) setChecking(false);
    }

    check();

    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      check();
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [allowRoles]);

  if (checking) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">
          <div className="card-title">Checking access…</div>
          <div className="card-subtitle">Please wait.</div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function SignOutButton() {
  return (
    <a className="btn btn-grey" href="/logout">
      Logout
    </a>
  );
}
