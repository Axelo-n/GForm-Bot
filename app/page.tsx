"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Dropdown } from "./dropdown";
import { makePlan, type Answer, type Config, type Form, type Question, type Row, type Weighted } from "./lib/plan";

import { importedConfig, parseForm, sameForm, type SavedSettings, type ScanRecord, type Workspace } from "./lib/workspace";

type Job = {
  id: string; kind: string; state: string; total: number; startedRows: number; success: number;
  failed: number; uncertain: number; message?: string; form?: Form;
};
type Entry = { time: string; message: string };
const initial: Config = { count: 50, mode: "independent", rules: {}, packages: [], min: 2, max: 5, workers: 1 };
const optionField = (q: Question) => ["radio", "checkbox", "dropdown"].includes(q.kind);

function defaults(form: Form): Config {
  return { ...initial, rules: Object.fromEntries(form.questions.map(q => {
    if (!optionField(q)) return [q.id, []];
    const available = q.required ? q.options : [...q.options, ""];
    const answers = q.kind === "checkbox" ? [q.required ? q.options.slice(0, 1) : []] : available;
    return [q.id, answers.map((answer, index) => ({ answer, weight: index === 0 ? 100 : 0 }))];
  })), packages: [{ row: {}, weight: 100 }] };
}

function AnswerField({ q, answer, update }: { q: Question; answer: Answer | undefined; update: (value: Answer) => void }) {
  if (q.kind === "checkbox") {
    const selected = Array.isArray(answer) ? answer : [];
    return <div className="choices">{q.options.map(option => <label key={option}>
      <input type="checkbox" checked={selected.includes(option)}
        onChange={e => update(e.target.checked ? [...selected, option] : selected.filter(value => value !== option))} />
      {option}
    </label>)}</div>;
  }
  if (optionField(q)) return <Dropdown label={q.title} value={typeof answer === "string" ? answer : ""} onChange={update}
    options={[{ value: "", label: q.required ? "Pilih jawaban" : "(Kosong)" },
      ...q.options.map(option => ({ value: option, label: option }))]} />;
  if (q.kind === "unsupported") return <small>Tipe pertanyaan belum didukung.</small>;
  return <input aria-label={q.title} type={q.kind} value={typeof answer === "string" ? answer : ""} onChange={e => update(e.target.value)} />;
}

function Percent({ value, change, label }: { value: number; change: (value: number) => void; label: string }) {
  return <label className="percent"><input aria-label={label} type="number" min="0" max="100" step="any"
    value={value} onChange={e => change(Number(e.target.value))} /> %</label>;
}

function Rules({ q, rules, setRules, raw, setRaw }: {
  q: Question; rules: Weighted[]; setRules: (rules: Weighted[]) => void; raw: string; setRaw: (raw: string) => void;
}) {
  if (q.kind === "unsupported") return <small>Tipe pertanyaan belum didukung.</small>;
  if (!optionField(q)) return <textarea aria-label={q.title} rows={3} value={raw} onChange={e => setRaw(e.target.value)}
    placeholder={q.kind === "date" ? "YYYY-MM-DD, satu jawaban per baris" :
      q.kind === "time" ? "HH:MM, satu jawaban per baris" : "Satu jawaban per baris"} />;

  const update = (index: number, patch: Partial<Weighted>) => setRules(rules.map((rule, at) => at === index ? { ...rule, ...patch } : rule));
  return <>
    {rules.map((rule, index) => <div key={index} className="rule">
      {q.kind === "checkbox" ? <AnswerField q={q} answer={rule.answer} update={answer => update(index, { answer })} /> :
        <span>{rule.answer || "(Kosong)"}</span>}
      <Percent label={`Persentase Q${q.id} opsi ${index + 1}`} value={rule.weight} change={weight => update(index, { weight })} />
      {q.kind === "checkbox" && <button className="subtle" type="button" onClick={() => setRules(rules.filter((_, at) => at !== index))}>Hapus</button>}
    </div>)}
    <div className="actions">
      {q.kind === "checkbox" && <button type="button" onClick={() => setRules([...rules, { answer: [], weight: 0 }])}>Tambah kombinasi</button>}
      <small>Total {Number(rules.reduce((sum, rule) => sum + rule.weight, 0).toFixed(6))}%</small>
    </div>
  </>;
}

async function api(query = "", data?: object) {
  const response = await fetch("/api/bot" + query, {
    cache: "no-store",
    ...(data ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Permintaan gagal.");
  return result;
}

function textFromConfig(form: Form, config: Config) {
  return Object.fromEntries(form.questions.filter(q => !optionField(q)).map(q => [
    q.id, (config.rules[q.id] ?? []).map(rule => rule.answer).join("\n"),
  ]));
}

function downloadJson(filename: string, value: object) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [form, setForm] = useState<Form>();
  const [config, setConfig] = useState<Config>(initial);
  const [text, setText] = useState<Record<number, string>>({});
  const knownScans = useRef(new Set<string>());
  const [ready, setReady] = useState(false);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [latest, setLatest] = useState<SavedSettings | null>(null);
  const [notice, setNotice] = useState("");
  const [job, setJob] = useState<Job>();
  const [pending, setPending] = useState(false);
  const [visibleBatch, setVisibleBatch] = useState(true);
  const [questionPage, setQuestionPage] = useState(0);
  const [questionSearch, setQuestionSearch] = useState("");
  const [selectedQuestion, setSelectedQuestion] = useState<number>();
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Row[]>();
  const [logsOpen, setLogsOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [selectedLog, setSelectedLog] = useState("");
  const [logs, setLogs] = useState<Entry[]>([]);
  const active = !ready || pending || job?.state === "running" || job?.state === "review";

  function showForm(next: Form, settings = defaults(next)) {
    setForm(next);
    setUrl(next.url);
    setConfig(settings);
    setText(textFromConfig(next, settings));
    setPreview(undefined);
    setQuestionPage(0);
    setQuestionSearch("");
    setSelectedQuestion(undefined);
  }

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const data: Workspace = await api("?workspace");
        if (cancelled) return;
        knownScans.current = new Set(data.scans.map(scan => scan.id));
        setScans(data.scans);
        setLatest(data.latest);
        if (data.latest) showForm(data.latest.form, data.latest.config);
        else if (data.scans[0]) showForm(data.scans[0].form);
      } catch (error) {
        if (!cancelled) setError((error as Error).message);
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    void restore();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    async function tick() {
      try {
        const { job: current } = await api();
        if (cancelled) return;
        setJob(current ?? undefined);
        if (current?.form && !knownScans.current.has(current.id)) {
          const data: Workspace = await api("?workspace");
          if (cancelled || knownScans.current.has(current.id)) return;
          knownScans.current.add(current.id);
          setScans(data.scans);
          showForm(current.form, latest && sameForm(current.form, latest.form) ? latest.config : undefined);
          setNotice("Hasil scan disimpan.");
        }
      } catch { /* Keep the current view while the local server reconnects. */ }
    }
    void tick();
    const interval = setInterval(tick, 750);
    return () => { cancelled = true; clearInterval(interval); };
  }, [ready, latest]);
  useEffect(() => {
    if (!logsOpen) return;
    let cancelled = false;
    async function tick() {
      try {
        const { ids } = await api("?history");
        const id = selectedLog || job?.id || ids[0];
        const entries = id ? (await api("?log=" + id)).logs : [];
        if (!cancelled) {
          setHistory(ids);
          setLogs(entries);
        }
      } catch (error) {
        if (!cancelled) setError((error as Error).message);
      }
    }
    void tick();
    const interval = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [logsOpen, selectedLog, job?.id]);

  function change(patch: Partial<Config>) {
    setPreview(undefined);
    setConfig(current => ({ ...current, ...patch }));
  }
  const packageQuestions = config.packageQuestions ?? form?.questions.map(q => q.id) ?? [];
  const isPackaged = (q: Question) => config.mode === "packages" && packageQuestions.includes(q.id);
  const packageColumns = form?.questions.filter(q => isPackaged(q) && q.kind !== "unsupported") ?? [];

  function currentConfig(): Config {
    const rules = { ...config.rules };
    for (const q of form?.questions ?? []) {
      if (!optionField(q)) rules[q.id] = (text[q.id] ?? "").split(/\r?\n/).map(line => line.trim())
        .filter(Boolean).map(answer => ({ answer, weight: 1 }));
    }
    return { ...config, rules };
  }

  async function workspaceAction(action: "save-settings" | "clear-settings" | "import-scan" | "import-settings", file?: File) {
    setError("");
    setNotice("");
    setPending(true);
    try {
      if (action === "clear-settings") {
        await api("", { action });
        setLatest(null);
        if (form) showForm(form);
        setNotice("Setting terbaru dihapus.");
      } else if (action === "import-scan" && file) {
        const value = JSON.parse(await file.text());
        const { scan }: { scan: ScanRecord } = await api("", { action, form: parseForm(value?.form ?? value) });
        knownScans.current.add(scan.id);
        setScans(previous => [scan, ...previous]);
        showForm(scan.form, latest && sameForm(scan.form, latest.form) ? latest.config : undefined);
        setNotice("Hasil scan diimpor.");
      } else {
        const next = action === "import-settings" && file
          ? importedConfig(JSON.parse(await file.text()), form)
          : form && { form, config: currentConfig() };
        if (!next) throw new Error("Buka hasil scan dulu.");
        const { latest: saved }: { latest: SavedSettings } = await api("", {
          action: "save-settings", settings: { version: 1, ...next },
        });
        setLatest(saved);
        if (action === "import-settings") showForm(saved.form, saved.config);
        setNotice(action === "import-settings" ? "Setting diimpor dan disimpan." : "Setting terbaru disimpan.");
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function act(action: "scan" | "test" | "batch" | "stop", event?: FormEvent) {
    event?.preventDefault();
    setError("");
    setNotice("");
    setPending(true);
    try {
      const result = await api("", { action, url, form, config: currentConfig(), visibleBatch });
      setJob(result.job);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  }

  const search = questionSearch.trim().toLocaleLowerCase("id-ID");
  const questionNumber = /^q?(\d+)$/.exec(search)?.[1];
  const visibleQuestions = form?.questions.filter(q =>
    (!questionPage || questionPage === q.page) &&
    (questionNumber ? q.id === Number(questionNumber) : q.title.toLocaleLowerCase("id-ID").includes(search))
  ) ?? [];
  const q = visibleQuestions.find(item => item.id === selectedQuestion) ?? visibleQuestions[0];

  return <main>
    <header>
      <div className="brand">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div><h1>GForm Bot</h1><p>Scan dan pengisian Google Forms dari komputer lu.</p></div>
      </div>
      <button onClick={() => setLogsOpen(!logsOpen)} aria-expanded={logsOpen}>{logsOpen ? "Tutup log" : "Riwayat & log"}</button>
    </header>
    {logsOpen && <section>
      <h2>Riwayat proses</h2>
      <Dropdown label="Pilih proses" value={selectedLog || job?.id || history[0] || ""} onChange={setSelectedLog}
        options={history.map(id => ({ value: id, label: id === job?.id ? `${job.kind} · Terbaru` : id }))} />
      <div className="logs">{logs.length ? logs.map((entry, index) => <div key={index}>
        <time>{new Date(entry.time).toLocaleString("id-ID")}</time> {entry.message}
      </div>) : "Belum ada log."}</div>
    </section>}

    <section>
      <h2>Scan form</h2>
      <form className="scan" onSubmit={e => void act("scan", e)}>
        <input required type="url" aria-label="Link Google Forms" placeholder="https://forms.gle/..." value={url} onChange={e => setUrl(e.target.value)} disabled={active} />
        <button className="primary" disabled={active}>Scan</button>
      </form>
    </section>

    <section>
      <h2>Riwayat scan</h2>
      <div className="actions">
        <label className="file-action">Import scan JSON
          <input type="file" accept=".json,application/json" disabled={active} onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void workspaceAction("import-scan", file);
          }} />
        </label>
        <label className="file-action">Import setting JSON
          <input type="file" accept=".json,application/json" disabled={active} onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void workspaceAction("import-settings", file);
          }} />
        </label>
      </div>
      {scans.length ? <ul className="scan-history">{scans.map(scan => <li key={scan.id}>
        <span><strong>{scan.form.title}</strong><small>{new Date(scan.savedAt).toLocaleString("id-ID")} · {scan.form.questions.length} pertanyaan</small></span>
        <button disabled={active} onClick={() => {
          showForm(scan.form, latest && sameForm(scan.form, latest.form) ? latest.config : undefined);
          setError("");
          setNotice("");
        }}>Buka</button>
        <button onClick={() => downloadJson(`scan-${scan.id}.json`, scan.form)}>Download JSON</button>
      </li>)}</ul> : <p>Belum ada hasil scan.</p>}
    </section>

    {notice && <p role="status">{notice}</p>}
    {job && <section className="status" data-state={job.state} aria-live="polite">
      <div><strong>{({ scan: "Scan", test: "Test", batch: "Batch" })[job.kind]}</strong> · {
        ({ running: "Berjalan", review: "Cek jendela Edge", done: "Selesai", stopped: "Dihentikan", error: "Gagal" })[job.state]}
        {job.kind === "batch" && <p>{job.success} berhasil · {job.failed} gagal · {job.uncertain} belum terkonfirmasi · {job.total - job.startedRows} antre</p>}
        {job.state === "review" && <p>Tutup jendela Edge atau klik Akhiri test setelah selesai cek.</p>}
        {job.message && <p className="error">{job.message}</p>}
      </div>
      {["running", "review"].includes(job.state) && <button disabled={pending} onClick={() => void act("stop")}>{job.state === "review" ? "Akhiri test" : "Stop"}</button>}
    </section>}
    {error && <p className="error" role="alert">{error}</p>}

    {form && <section>
      <h2>{form.title}</h2>
      <p>{form.pages} halaman · {form.questions.length} pertanyaan</p>
      <fieldset disabled={active}>
        <div className="actions">
          <button onClick={() => void workspaceAction("save-settings")}>Save setting</button>
          <button onClick={() => void workspaceAction("clear-settings")}>Clear setting</button>
          <button onClick={() => downloadJson("gform-setting.json", { version: 1, form, config: currentConfig() })}>Download setting JSON</button>
        </div>
        <div className="settings">
          <div className="setting-field">Mode jawaban
            <Dropdown label="Mode jawaban" value={config.mode}
              onChange={mode => change({ mode: mode as Config["mode"] })}
              options={[{ value: "independent", label: "Independen" }, { value: "packages", label: "Paket" }]} />
          </div>
          {[["count", "Jumlah respons"], ["min", "Jeda min. (detik)"], ["max", "Jeda maks. (detik)"], ["workers", "Paralel"]].map(([key, title]) => <label key={key}>
            {title}<input type="number" min={key === "count" || key === "workers" ? 1 : 0} step={key === "min" || key === "max" ? "any" : 1}
              value={config[key as "count" | "min" | "max" | "workers"]} onChange={e => change({ [key]: Number(e.target.value) })} />
          </label>)}
        </div>

        {config.mode === "packages" && <details className="page-group package-editor" key={form.url}>
          <summary>Paket jawaban <small>{config.packages.length} paket</small></summary>
          <div className="table-wrap package-table">
            <table aria-label="Paket jawaban">
              <thead><tr>
                <th scope="col">Paket</th>
                {packageColumns.map(q => <th scope="col" key={q.id}>{q.title}{q.required ? " *" : ""}</th>)}
                <th scope="col">Bobot</th>
                <th scope="col">Tindakan</th>
              </tr></thead>
              <tbody>{config.packages.map((pack, index) => <tr key={index}>
                <th scope="row">{index + 1}</th>
                {packageColumns.map(q => <td key={q.id}>
                  <AnswerField q={q} answer={pack.row[q.id]} update={answer => change({
                    packages: config.packages.map((item, i) => i === index
                      ? { ...item, row: { ...item.row, [q.id]: answer } } : item),
                  })} />
                </td>)}
                <td><Percent label={`Bobot paket ${index + 1}`} value={pack.weight} change={weight =>
                  change({ packages: config.packages.map((item, i) => i === index ? { ...item, weight } : item) })} /></td>
                <td><button aria-label={`Hapus paket ${index + 1}`} onClick={() =>
                  change({ packages: config.packages.filter((_, i) => i !== index) })}>Hapus</button></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="actions package-actions">
            <button onClick={() => change({ packages: [...config.packages, { row: {}, weight: 0 }] })}>Tambah paket</button>
            <small>{config.packages.length} paket · Total bobot {Number(config.packages.reduce((sum, pack) => sum + pack.weight, 0).toFixed(6))}%</small>
          </div>
        </details>}
        <div className="page-group">
          <h3>Pertanyaan <small>{visibleQuestions.length} / {form.questions.length}</small></h3>
          <div className="question-filters">
            <input type="search" aria-label="Cari pertanyaan" placeholder="Cari judul atau nomor, misalnya Q10" value={questionSearch}
              onChange={e => setQuestionSearch(e.target.value)} />
            <Dropdown label="Filter halaman" value={String(questionPage)} onChange={page => setQuestionPage(Number(page))}
              options={[{ value: "0", label: "Semua halaman" }, ...Array.from({ length: form.pages },
                (_, i) => ({ value: String(i + 1), label: `Halaman ${i + 1}` }))]} />
          </div>
          {q ? <div className="question-workspace">
            <div className="question-list" role="group" aria-label="Daftar pertanyaan">
              {visibleQuestions.map(item => <button type="button" key={item.id} aria-pressed={item.id === q.id}
                onClick={() => setSelectedQuestion(item.id)} title={item.title}>
                <small>Q{item.id}</small><span>{item.title}</span>
              </button>)}
            </div>
            <div className="question" key={q.id}>
              <div className="question-title"><strong>Q{q.id}. {q.title}</strong><small>Halaman {q.page} · {q.kind} · {q.required ? "wajib" : "opsional"}</small></div>
              {isPackaged(q) && q.options.length > 0 && <small>{q.options.join(" · ")}</small>}
              {config.mode === "packages" && q.kind !== "unsupported" && <label className="choices">
                <input type="checkbox" checked={isPackaged(q)} onChange={e => change({
                  packageQuestions: e.target.checked ? [...packageQuestions, q.id] : packageQuestions.filter(id => id !== q.id),
                })} /> Masukkan ke paket
              </label>}
              {isPackaged(q) ? <small>Edit jawabannya lewat Paket jawaban.</small> :
                <Rules q={q} raw={text[q.id] ?? ""} rules={config.rules[q.id] ?? []}
                  setRules={rules => change({ rules: { ...config.rules, [q.id]: rules } })}
                  setRaw={raw => { setText({ ...text, [q.id]: raw }); setPreview(undefined); }} />}
            </div>
          </div> : <p>Tidak ada pertanyaan yang cocok.</p>}
        </div>

        <div className="actions bottom">
          <label className="choices">
            <input type="checkbox" checked={visibleBatch} onChange={e => setVisibleBatch(e.target.checked)} />
            Tampilkan Edge saat batch
          </label>
          <button onClick={() => {
            setError("");
            try { setPreview(makePlan(form, currentConfig())); }
            catch (error) { setError((error as Error).message); }
          }}>Preview</button>
          <button onClick={() => void act("test")}>Test 1 respons</button>
          <button className="primary" onClick={() => {
            if (window.confirm(`Kirim ${config.count} respons ke “${form.title}”?`)) void act("batch");
          }}>Run batch</button>
        </div>
      </fieldset>

      {preview && <div className="page-group">
        <h3>Preview {preview.length} respons</h3>
        <div className="table-wrap preview-table"><table><thead><tr><th>Pertanyaan</th><th>Kuota pilihan</th>
          {preview.slice(0, 3).map((_, index) => <th key={index}>Contoh {index + 1}</th>)}</tr></thead>
          <tbody>{form.questions.map(q => <tr key={q.id}><th>{q.id}. {q.title}</th>
            <td>{optionField(q) ? q.options.map(option => {
              const amount = preview.filter(row => Array.isArray(row[q.id]) ? row[q.id].includes(option) : row[q.id] === option).length;
              return <div key={option}>{option} · {amount}/{preview.length}</div>;
            }) : "—"}</td>
            {preview.slice(0, 3).map((row, i) => {
              const answer = row[q.id];
              return <td key={i}>{(Array.isArray(answer) ? answer.join(", ") : answer) || "—"}</td>;
            })}
          </tr>)}</tbody>
        </table></div>
      </div>}
    </section>}
  </main>;
}
