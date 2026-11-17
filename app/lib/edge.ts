import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export { sleep };

export async function waitFor<T>(read: () => Promise<T | undefined>, message: string, timeout = 12000) {
  const until = Date.now() + timeout;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await sleep(150);
  } while (Date.now() < until);
  throw new Error(message);
}

export async function openEdge(visible: boolean) {
  const edge = [process.env.GFORM_EDGE_PATH, ...[process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean).map(base => join(base!, "Microsoft", "Edge", "Application", "msedge.exe"))]
    .find(path => path && existsSync(path));
  if (!edge) throw new Error("Microsoft Edge tidak ditemukan. Atur GFORM_EDGE_PATH ke lokasi msedge.exe.");

  const profile = await mkdtemp(join(tmpdir(), "gform-edge-"));
  const browser = spawn(edge, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode", ...(visible ? [] : ["--headless=new"]), "about:blank",
  ], { stdio: "ignore", windowsHide: !visible });
  let launchError: Error | undefined;
  browser.on("error", error => { launchError = error; });
  let socket: WebSocket | undefined;
  const closed = new Promise<void>(resolve => browser.once("close", () => resolve()));
  const close = async () => {
    socket?.close();
    browser.kill();
    await Promise.race([closed, sleep(2000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  };

  try {
    const port = await waitFor(async () => {
      if (launchError) throw launchError;
      if (browser.exitCode !== null) throw new Error("Edge berhenti saat dibuka.");
      const info = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
      return info.trim() ? Number(info.split(/\r?\n/)[0]) : undefined;
    }, "Edge belum membuka koneksi debugging.");
    const address = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
      if (!response?.ok) return;
      const targets: { type: string; webSocketDebuggerUrl: string }[] = await response.json();
      return targets.find(target => target.type === "page")?.webSocketDebuggerUrl;
    }, "Tab Edge tidak ditemukan.");

    const connection = new WebSocket(address);
    socket = connection;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Koneksi Edge habis waktu.")), 5000);
      connection.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      connection.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Koneksi Edge gagal.")); }, { once: true });
    });
    let sequence = 0;
    const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
    connection.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const call = pending.get(message.id);
      if (!call) return;
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    });
    connection.addEventListener("close", () => {
      for (const call of pending.values()) call.reject(new Error("Browser test ditutup atau koneksi Edge terputus."));
    });

    async function command<T>(method: string, params: object): Promise<T> {
      if (connection.readyState !== WebSocket.OPEN) throw new Error("Koneksi Edge tertutup.");
      const id = ++sequence;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<T>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} habis waktu.`)), 12000);
          pending.set(id, { resolve: value => resolve(value as T), reject });
          connection.send(JSON.stringify({ id, method, params }));
        });
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    }

    return {
      close,
      closed,
      async click(x: number, y: number) {
        await command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      },
      async navigate(url: string) {
        const result = await command<{ errorText?: string }>("Page.navigate", { url });
        if (result.errorText) throw new Error(result.errorText);
      },
      async evaluate<T>(source: string, args: unknown[] = []): Promise<T> {
        const result = await command<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
          "Runtime.evaluate", { expression: `(${source})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true },
        );
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
