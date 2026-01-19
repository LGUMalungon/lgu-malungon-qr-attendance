"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { AuthGuard, SignOutButton } from "../components/AuthGuard";

type UploadRow = {
  upload_id: string;
  filename: string;
  uploaded_at: string;
  uploaded_by_role: string | null;
  row_count: number;
};

function formatPH(iso?: string | null) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function normalizeHeader(h: string) {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

function parseCSV(text: string) {
  // Minimal CSV parser: handles commas and quoted fields
  const rows: string[][] = [];
  let cur = "";
  let inQuotes = false;
  const row: string[] = [];

  function pushCell() {
    row.push(cur);
    cur = "";
  }
  function pushRow() {
    rows.push(row.splice(0, row.length));
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && ch === ",") {
      pushCell();
      continue;
    }

    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      // handle CRLF
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushCell();
      pushRow();
      continue;
    }

    cur += ch;
  }

  // last cell/row
  pushCell();
  pushRow();

  // remove empty trailing rows
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) {
    rows.pop();
  }

  return rows;
}

function MasterlistInner() {
  const [role, setRole] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const [errors, setErrors] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<any[]>([]);
  const [validRows, setValidRows] = useState<any[]>([]);
  const [uploadHistory, setUploadHistory] = useState<UploadRow[]>([]);
const [successMsg, setSuccessMsg] = useState<string>("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setRole((data.session?.user?.user_metadata?.role ?? "") as string);
    });
    refreshHistory();
  }, []);

  async function refreshHistory() {
    const { data, error } = await supabase
      .from("masterlist_uploads")
      .select("upload_id,filename,uploaded_at,uploaded_by_role,row_count")
      .order("uploaded_at", { ascending: false });

    if (error) {
      // Don’t block the page; just show hint in console.
      console.warn("Failed to load masterlist history:", error.message);
      return;
    }

    setUploadHistory((data as any) ?? []);
  }

  const latest = useMemo(() => uploadHistory?.[0] ?? null, [uploadHistory]);

  async function onPickFile(f: File | null) {
    setFile(f);
    setErrors([]);
    setPreviewRows([]);
    setValidRows([]);

    if (!f) return;

    const text = await f.text();
    const rows = parseCSV(text);

    if (rows.length < 2) {
      setErrors(["CSV must include a header row and at least 1 data row."]);
      return;
    }

    const header = rows[0].map((h) => normalizeHeader(h));
    const required = ["employee_id", "full_name", "department"];
    const missing = required.filter((r) => !header.includes(r));

    if (missing.length) {
      setErrors(missing.map((m) => `Missing column: ${m}`));
      return;
    }

    const idx = (name: string) => header.indexOf(name);

    const parsed = rows.slice(1).map((r) => {
      const employee_id = (r[idx("employee_id")] ?? "").trim();
      const full_name = (r[idx("full_name")] ?? "").trim();
      const department = (r[idx("department")] ?? "").trim();
      const is_active_raw =
        idx("is_active") >= 0 ? (r[idx("is_active")] ?? "").trim() : "";
      const is_active =
        is_active_raw === ""
          ? true
          : ["true", "1", "yes", "y"].includes(is_active_raw.toLowerCase());

      return { employee_id, full_name, department, is_active };
    });

    const rowErrors: string[] = [];
    const valid: any[] = [];

    parsed.forEach((p, i) => {
      const line = i + 2; // header is line 1
      if (!p.employee_id) rowErrors.push(`Line ${line}: employee_id is blank.`);
      if (!p.full_name) rowErrors.push(`Line ${line}: full_name is blank.`);
      if (!p.department) rowErrors.push(`Line ${line}: department is blank.`);
      if (p.employee_id && !/^EMP-\d{3,}$/.test(p.employee_id)) {
        rowErrors.push(
          `Line ${line}: employee_id "${p.employee_id}" must look like EMP-001.`
        );
      }
      if (p.employee_id && p.full_name && p.department) valid.push(p);
    });

    if (rowErrors.length) {
      setErrors(rowErrors.slice(0, 30));
    }

    setValidRows(valid);
    setPreviewRows(valid.slice(0, 8));
  }

  async function uploadToDatabase() {
    if (!file) {
      alert("Please choose a CSV file first.");
      return;
    }
    if (errors.length) {
      alert("Fix errors first before uploading.");
      return;
    }
    if (!validRows.length) {
      alert("No valid rows to upload.");
      return;
    }

    setBusy(true);
    try {
      // Upsert employees by employee_id
      const { error } = await supabase
        .from("employees")
        .upsert(validRows, { onConflict: "employee_id" });

      if (error) {
        alert(`Upload failed: ${error.message}`);
        return;
      }

      // Log this upload (filename + row_count + actor)
      const { data: sess } = await supabase.auth.getSession();
      const userId = sess.session?.user?.id ?? null;

      const { error: logErr } = await supabase.from("masterlist_uploads").insert([
        {
          filename: file.name,
          uploaded_by: userId,
          uploaded_by_role: role || null,
          row_count: validRows.length,
        },
      ]);

      if (logErr) {
        // Upload succeeded; only logging failed
        alert(`Uploaded employees, but failed to log filename: ${logErr.message}`);
      } else {
        setSuccessMsg(`Masterlist uploaded successfully: ${validRows.length} rows.`);

      }

      // Refresh list + clear UI
      await refreshHistory();
      setFile(null);
      setPreviewRows([]);
      setValidRows([]);
      setErrors([]);
      const input = document.getElementById("ml-file") as HTMLInputElement | null;
      if (input) input.value = "";
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
        <a className="sidebar-link" href="/reports">
          Reports
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
              Upload CSV and track which masterlist is currently in use.
            </div>
          </div>

          <div className="session-indicator">
            <div className="session-label">Current masterlist</div>
            <div className="session-sub">
              {latest ? (
                <>
                  <b>{latest.filename}</b> • {formatPH(latest.uploaded_at)} •{" "}
                  {latest.row_count} rows
                </>
              ) : (
                "No uploads yet."
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16 }}>
          {/* Upload card */}
          <div className="card">
            <div className="card-title">Upload CSV</div>
            <div className="card-subtitle">
              Required: <b>employee_id</b>, <b>full_name</b>, <b>department</b>.
              Optional: <b>is_active</b>. employee_id must look like <b>EMP-001</b>.
            {successMsg && (
  <div
    style={{
      marginTop: 10,
      marginBottom: 12,
      padding: 12,
      borderRadius: 12,
      background: "rgba(22,163,74,0.12)",
      border: "1px solid rgba(22,163,74,0.25)",
      fontWeight: 900,
    }}
  >
    {successMsg}
  </div>
)}

            </div>

            <input
              id="ml-file"
              type="file"
              accept=".csv"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />

            <div style={{ height: 12 }} />

            <button className="btn btn-orange" onClick={uploadToDatabase} disabled={busy}>
              {busy ? "Uploading..." : "Upload to database"}
            </button>

            {errors.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    padding: 10,
                    borderRadius: 12,
                    background: "rgba(239,68,68,0.10)",
                    border: "1px solid rgba(239,68,68,0.25)",
                    fontWeight: 900,
                    marginBottom: 8,
                  }}
                >
                  Please fix:
                </div>

                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {errors.map((e, i) => (
                    <li key={i} style={{ marginBottom: 6 }}>
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {previewRows.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="card-title" style={{ fontSize: 16 }}>
                  Preview
                </div>
                <div className="hint">
                  Showing first 8 valid rows ({validRows.length} total).
                </div>

                <div
                  style={{
                    marginTop: 10,
                    border: "1px solid rgba(0,0,0,0.08)",
                    borderRadius: 16,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "140px 1.2fr 1fr 80px",
                      gap: 10,
                      padding: 12,
                      background: "rgba(249,115,22,0.12)",
                      fontWeight: 900,
                    }}
                  >
                    <div>Employee ID</div>
                    <div>Full name</div>
                    <div>Department</div>
                    <div>Active</div>
                  </div>

                  {previewRows.map((r, i) => (
                    <div
                      key={i}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "140px 1.2fr 1fr 80px",
                        gap: 10,
                        padding: 12,
                        borderTop: "1px solid rgba(0,0,0,0.06)",
                        alignItems: "center",
                      }}
                    >
                      <div style={{ fontWeight: 900 }}>{r.employee_id}</div>
                      <div>{r.full_name}</div>
                      <div>{r.department}</div>
                      <div>{r.is_active ? "Yes" : "No"}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Upload history */}
          <div className="card">
            <div className="card-title">Upload history</div>
            <div className="card-subtitle">
              Newest at the top. This helps trace which masterlist is being used.
            </div>

            <div style={{ marginTop: 10, maxHeight: 520, overflow: "auto", paddingRight: 4 }}>
              {uploadHistory.length === 0 ? (
                <div className="hint">No masterlist uploads yet.</div>
              ) : (
                uploadHistory.map((u, idx) => (
                  <div
                    key={u.upload_id}
                    style={{
                      border: "1px solid rgba(0,0,0,0.08)",
                      borderRadius: 14,
                      padding: 12,
                      marginBottom: 10,
                      background:
                        idx === 0 ? "rgba(249,115,22,0.10)" : "white",
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>
                      {u.filename} {idx === 0 ? "(current)" : ""}
                    </div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      {formatPH(u.uploaded_at)} • {u.row_count} rows
                      {u.uploaded_by_role ? ` • ${u.uploaded_by_role}` : ""}
                    </div>
                  </div>
                ))
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
