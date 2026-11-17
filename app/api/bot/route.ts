import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { googleUrl, openEdge, sleep, submit, walk, RejectedResponse } from "../../lib/google-form";
import { makePlan, type Config, type Form } from "../../lib/plan";



import { parseForm, parseSettings, type ScanRecord, type Workspace } from "../../lib/workspace";

type Job = {
  id: string; started: string; kind: "scan" | "test" | "batch"; state: "running" | "review" | "done" | "error" | "stopped";
  total: number; startedRows: number; success: number; failed: number; uncertain: number;
  form?: Form; message?: string;
};
const globals = globalThis as typeof globalThis & { gformBot?: { job: Job; stop: AbortController } };
const dataDirectory = join(process.cwd(), ".gform-local");
const logDirectory = join(dataDirectory, "logs");
const scanDirectory = join(dataDirectory, "scans");
const latestPath = join(dataDirectory, "latest-settings.json");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function storeJson(path: string, data: object) {
  const temporary = path + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function saveScan(form: Form, id: string = randomUUID()): ScanRecord {
  form = { ...parseForm(form), url: googleUrl(form.url) };
  mkdirSync(scanDirectory, { recursive: true });
  const scan = { id, savedAt: new Date().toISOString(), form };
  storeJson(join(scanDirectory, id + ".json"), scan);
  return scan;
}

function workspace(): Workspace {
  mkdirSync(scanDirectory, { recursive: true });
  const scans = readdirSync(scanDirectory)
    .filter(name => /^[a-f\d-]{36}\.json$/.test(name))
    .map(name => readJson<ScanRecord>(join(scanDirectory, name)))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  let latest: Workspace["latest"] = null;
  try {
    latest = parseSettings(readJson<unknown>(latestPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { scans, latest };
}

function allowed(request: Request) {
  // Next can synthesize an internal request URL. The browser sees the HTTP Host.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return false;
  const origin = request.headers.get("origin");
  return (origin === null || origin === new URL(`http://${host}`).origin) &&
    !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "");
}

function journal(job: Job, message: string) {
  mkdirSync(logDirectory, { recursive: true });
  appendFileSync(join(logDirectory, job.id + ".jsonl"), JSON.stringify({
    time: new Date().toISOString(), message, status: job.state, kind: job.kind,
  }) + "\n");
}

function history() {
  mkdirSync(logDirectory, { recursive: true });
  return readdirSync(logDirectory, { withFileTypes: true })
    .filter(file => file.isFile() && /^[\da-f-]{36}\.jsonl$/.test(file.name))
    .map(file => ({ id: file.name.slice(0, -6), time: statSync(join(logDirectory, file.name)).birthtimeMs }))
    .sort((a, b) => b.time - a.time).map(file => file.id);
}

export async function GET(request: Request) {
  if (!allowed(request)) return Response.json({ error: "Akses lewat localhost." }, { status: 403 });
  const url = new URL(request.url);
  if (url.searchParams.has("workspace")) {
    try { return Response.json(workspace()); }
    catch { return Response.json({ error: "Data scan atau setting lokal tidak bisa dibaca." }, { status: 500 }); }
  }
  const id = url.searchParams.get("log");
  if (id && /^[\da-f-]{36}$/.test(id)) {
    try {
      const logs = readFileSync(join(logDirectory, id + ".jsonl"), "utf8").trim().split("\n")
        .filter(Boolean).map(line => JSON.parse(line));
      return Response.json({ logs });
    } catch {
      return Response.json({ error: "Log tidak bisa dibaca." }, { status: 404 });
    }
  }
  if (url.searchParams.has("history")) return Response.json({ ids: history() });
  return Response.json({ job: globals.gformBot?.job ?? null });
}

export async function POST(request: Request) {
  if (!allowed(request) || !request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "Akses lewat localhost." }, { status: 403 });
  }

  try {
    const body = await request.json();
    if (body.action === "import-scan") return Response.json({ scan: saveScan(parseForm(body.form)) });
    if (body.action === "save-settings") {
      const saved = parseSettings(body.settings);
      saved.form.url = googleUrl(saved.form.url);
      mkdirSync(dataDirectory, { recursive: true });
      storeJson(latestPath, saved);
      return Response.json({ latest: saved });
    }
    if (body.action === "clear-settings") {
      rmSync(latestPath, { force: true });
      return Response.json({ latest: null });
    }
    const active = globals.gformBot;
    if (body.action === "stop") {
      active?.stop.abort();
      return Response.json({ job: active?.job ?? null });
    }
    if (active && ["running", "review"].includes(active.job.state)) throw new Error("Masih ada proses aktif.");
    const kind = body.action;
    if (kind !== "scan" && kind !== "test" && kind !== "batch") throw new Error("Aksi tidak dikenal.");
    const form: Form | undefined = kind === "scan" ? undefined : body.form;
    if (kind !== "scan" && !form) throw new Error("Scan form dulu.");
    const url = googleUrl(form?.url ?? body.url);
    const config: Config = body.config;
    const visibleBatch = body.visibleBatch === true;
    const rows = form ? makePlan(form, config) : [];
    const stop = new AbortController();
    const stopped = () => stop.signal.aborted;
    const job: Job = { id: randomUUID(), started: new Date().toISOString(), kind, state: "running",
      total: kind === "batch" ? rows.length : 1, startedRows: 0, success: 0, failed: 0, uncertain: 0 };
    const log = (message: string) => journal(job, message);
    log("Proses dimulai.");
    globals.gformBot = { job, stop };

    async function run() {
      try {
        if (kind === "batch") {
          const pending = new Set<Promise<void>>();
          let nextStart = 0;
          try {
            for (const [index, row] of rows.entries()) {
              if (pending.size >= config.workers) await Promise.race(pending);
              await sleep(Math.max(0, nextStart - Date.now()), undefined, { signal: stop.signal });
              if (stopped()) break;
              nextStart = Date.now() + 1000 * (config.min + Math.random() * (config.max - config.min));
              job.startedRows++;
              const number = index + 1;
              const note = (message: string) => log(`Respons ${number}/${rows.length} · ${message}`);
              const attempt = (async () => {
                let browser: Awaited<ReturnType<typeof openEdge>> | undefined;
                let clicked = false;
                try {
                  note("Membuka Edge");
                  browser = await openEdge(visibleBatch);
                  await walk(browser, url, "batch", note, form, row, stopped, visibleBatch);
                  if (stopped()) throw new Error("Dihentikan sebelum submit.");
                  note("Mengirim respons");
                  clicked = true;
                  if (!form) throw new Error("Scan form dulu.");
                  await submit(browser, form);
                  job.success++;
                  note("Google Forms mengonfirmasi pengiriman.");
                } catch (error) {
                  const uncertain = clicked && !(error instanceof RejectedResponse);
                  const cancelled = !clicked && stopped();
                  if (uncertain) job.uncertain++;
                  else if (!cancelled) job.failed++;
                  note(`${uncertain ? "Belum terkonfirmasi" : cancelled ? "Dihentikan" : "Gagal"} · ${(error as Error).message}`);
                } finally {
                  await browser?.close();
                }
              })().finally(() => { pending.delete(attempt); });
              pending.add(attempt);
            }
          } catch (error) {
            if (!stopped()) throw error;
          } finally {
            await Promise.all(pending);
          }
        } else {
          const browser = await openEdge(true);
          job.startedRows = 1;
          try {
            const scanned = await walk(browser, url, kind, log, form, rows[0], stopped);
            if (kind === "scan") job.form = saveScan(scanned, job.id).form;
            else {
              job.state = "review";
              log("Browser siap dicek di halaman terakhir. Bot berhenti sebelum Submit.");
              const end = new Promise<void>(resolve => {
                if (stopped()) resolve();
                else stop.signal.addEventListener("abort", () => resolve(), { once: true });
              });
              await Promise.race([browser.closed, end]);
              job.success = 1;
              job.state = "done";
            }
            if (!stopped()) job.success = 1;
          } finally {
            await browser.close();
          }
        }
        job.state = job.state === "done" ? "done" : stopped() ? "stopped" : "done";
        log(job.state === "stopped" ? "Proses dihentikan." : "Proses selesai.");
      } catch (error) {
        job.message = (error as Error).message;
        job.state = stopped() ? "stopped" : "error";
        if (job.state === "error") job.failed = 1;
        log(job.message);
      }
    }

    void run().catch(error => {
      job.state = "error";
      job.message = (error as Error).message;
    });
    return Response.json({ job });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
