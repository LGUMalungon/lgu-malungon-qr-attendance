"use client";

import { useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { AuthGuard, SignOutButton } from "../components/AuthGuard";

type Row = {
  employee_id: string;
  full_name: string;
  department: string;
  is_active: boolean;
};

function parseCSV(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return { headers: [], rows: [] as string[][] };

  const parseLine = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"' && line[i - 1] !== "\\") {
        inQ = !inQ;
        continue;
      }

      if (ch === "," && !inQ) {
        out.push(cur.trim());
        cur = "";
        continue;
      }

      cur += ch;
    }

    out.push(cur.trim());
    return out.map((v) => v.replace(/^"|"$/g, "").trim());
  };

  const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map(parseLine);

  return { headers, rows };
}

function normBool(v: string) {
  const x = (v ?? "").toString().trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(x)) return true;
  if (["0", "false", "no", "n"].includes(x)) return false;
  return true;
}

function MasterlistInner() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Row[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const previewTop = useMemo(() => preview.slice(0, 8), [preview]);

  async function onPickFile(file: File | null) {
    setMsg(null);
    setErrors([]);
    setPreview([]);
    setFileName(file ? file.name : null);
    if (!file) return;

    const text = await file.text();
    const { headers, rows } = parseCSV(text);

    const idxEmp = headers.indexOf("employee_id");
    const idxName = headers.indexOf("full_name");
    const idxDept = headers.indexOf("department");
    const idxActive = headers.indexOf("is_active");

    const e: string[] = [];
    if (idxEmp === -1) e.push("Missing column: employee_id");
    if (idxName === -1) e.push("Missing column: full_name");
    if (idxDept === -1) e.push("Missing column: department");

    if (e.length) {
      setErrors(e);
      return;
    }

    const out: Row[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      const employee_id = (r[idxEmp] ?? "").trim();
      const full_name = (r[idxName] ?? "").trim();
      const department = (r[idxDept] ?? "").trim();
      const is_active =
        idxActive === -1 ? true : normBool((r[idxActive] ?? "").trim());

      if (!employee_id || !full_name || !department) {
        e.push(`Row ${i + 2}: employee_id, full_name, department required.`);
        continue;
      }

      out.push({ employee_id, full_name, department, is_active });
    }

    if (e.length) {
      const head = e.slice(0, 12);
      const extra = e.length - head.length;
      setErrors(extra > 0 ? [...head, `…and ${extra} more.`] : head);
    }

    setPreview(out);
  }

  async function uploadToDB() {
    setMsg(null);
    setErrors([]);

    if (preview.length === 0) {
      setErrors(["No valid rows to upload."]);
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase
        .from("employees")
        .upsert(preview, { onConflict: "employee_id" });

      if (error) {
        setErrors([error.message]);
        return;
      }

      await supabase.from("audit_logs").insert([
        {
          action: "masterlist_upload",
          session_id: null,
          actor_role: "app_master",
          details: { fileName, rows: preview.length },
        },
      ]);

      setMsg(`Uploaded successfully: ${preview.length} employees.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-title">Menu</div>

        <a className="sidebar-link" href="/dashboard">
          Dashboard
        </a>
        <a className="sidebar-link" href="/scanner">
          Scanner
        </a>
        <a className="sidebar-link active" href="/masterlist">
          Masterlist
        </a>

        <div style={{ height: 10 }} />
        <SignOutButton />
      </aside>

      <section className="content">
        <div className="content-header">
          <div>
            <div className="page-title">Masterlist</div>
            <div className="page-subtitle">
              App Master only. Upload CSV to update employees.
            </div>
          </div>
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-title">Upload CSV</div>
            <div className="card-subtitle">
              Required: <b>employee_id</b>, <b>full_name</b>, <b>department</b>.
              Optional: <b>is_active</b>.
            </div>

            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />

            <div style={{ height: 12 }} />

            <button
              className="btn btn-orange"
              onClick={uploadToDB}
              disabled={busy || preview.length === 0}
            >
              {busy ? "Uploading..." : "Upload to database"}
            </button>

            {msg && (
              <div className="success-box" style={{ marginTop: 12 }}>
                {msg}
              </div>
            )}

            {errors.length > 0 && (
              <div className="error-box" style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>
                  Please fix:
                </div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {errors.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">Preview</div>
            <div className="card-subtitle">
              Showing first 8 valid rows ({preview.length} total).
            </div>

            <div className="table" style={{ marginTop: 10 }}>
              <div className="thead">
                <div>Employee ID</div>
                <div>Full name</div>
                <div>Department</div>
                <div>Active</div>
              </div>

              {previewTop.map((r) => (
                <div className="trow" key={r.employee_id}>
                  <div>{r.employee_id}</div>
                  <div>{r.full_name}</div>
                  <div>{r.department}</div>
                  <div>{r.is_active ? "Yes" : "No"}</div>
                </div>
              ))}

              {preview.length === 0 && (
                <div className="trow">
                  <div style={{ gridColumn: "1 / -1", opacity: 0.7 }}>
                    No file loaded yet.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function MasterlistPage() {
  return (
    <AuthGuard allowRoles={["app_master"]}>
      <MasterlistInner />
    </AuthGuard>
  );
}
