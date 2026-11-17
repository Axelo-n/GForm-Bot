import { openEdge, sleep, waitFor } from "./edge";
import type { Answer, Form, Question, Row } from "./plan";

type Browser = Awaited<ReturnType<typeof openEdge>>;
type Snapshot = {
  url: string; title: string; key: string; next: boolean; submit: boolean;
  questions: Omit<Question, "id" | "page">[]; errors: string[]; confirmed: boolean;
};

export function googleUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ((url.hostname === "forms.gle" && /^\/[a-z0-9_-]+\/?$/i.test(url.pathname)) ||
       (url.hostname === "docs.google.com" && /^\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?[\w-]+\/viewform\/?$/.test(url.pathname)))) {
    return url.origin + url.pathname;
  }
  throw new Error("Masukkan link responden Google Forms (forms.gle atau docs.google.com).");
}

// Runs inside the isolated Edge tab. Keep the reader and actions on the same selectors.
const formDom = String.raw`async (action, index, answer) => {
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const all = (scope, selector) => [...scope.querySelectorAll(selector)].filter(visible);
  const label = element => (element?.innerText ?? "").replace(/\s+/g, " ").trim();
  const optionLabel = element => element.getAttribute("data-value") || element.getAttribute("aria-label") || label(element);
  const originOk = location.origin === "https://docs.google.com" && /^\/forms\/(?:u\/\d+\/)?d\//.test(location.pathname);
  if (!originOk) {
    if (action !== "read") throw new Error("Tab sudah keluar dari Google Forms.");
    return null;
  }

  if (action === "read" && document.readyState !== "complete") return null;
  const form = document.querySelector("form");
  const cards = form ? all(form, '[role="listitem"]') : [];
  const buttons = form ? all(form, '[role="button"],button') : [];
  const next = buttons.find(button => /^(next|berikutnya|selanjutnya|lanjut)$/i.test(label(button)));
  const submit = buttons.find(button => /^(submit|kirim)$/i.test(label(button)));
  const controls = card => {
    const radios = all(card, '[role="radio"]');
    const checks = all(card, '[role="checkbox"]');
    const drop = all(card, '[role="listbox"]');
    const input = all(card, 'input:not([type="hidden"]),textarea');
    const groups = [radios.length > 0, checks.length > 0, drop.length > 0].filter(Boolean).length;
    if (groups > 1 || all(card, '[role="radiogroup"],[role="group"]').filter(group => all(group, '[role="radio"],[role="checkbox"]').length).length > 1)
      return { kind: "unsupported", nodes: [] };
    if (radios.length) return { kind: "radio", nodes: radios };
    if (checks.length) return { kind: "checkbox", nodes: checks };
    if (drop.length === 1) return { kind: "dropdown", nodes: drop };
    if (input.length === 1) {
      const type = input[0].type;
      if (["date", "time"].includes(type)) return { kind: type, nodes: input };
      if (["text", "textarea", "email", "number", "url", "tel"].includes(type)) return { kind: "text", nodes: input };
    }
    return { kind: "unsupported", nodes: [] };
  };
  const titleFor = card => label(card.querySelector('[role="heading"]')).replace(/\s*\*$/, "").trim();
  const listOptions = async list => {
    list.click();
    await new Promise(resolve => setTimeout(resolve, 320));
    return all(list, '[role="option"]').filter(option => optionLabel(option) && option.getAttribute("data-value") !== "" && !/^(choose|pilih)$/i.test(optionLabel(option)));
  };
  if (action === "next" || action === "submit") {
    const button = action === "next" ? next : submit;
    if (!button || (action === "submit" && next)) throw new Error("Tombol " + action + " tidak tersedia pada halaman ini.");
    button.click();
    return true;
  }
  if (action === "answer" || action === "checked") {
    const card = cards[index];
    if (!card) throw new Error("Posisi pertanyaan berubah.");
    const { kind, nodes } = controls(card);
    if (kind === "radio" || kind === "checkbox") {
      const option = nodes.find(node => optionLabel(node) === answer);
      if (!option) throw new Error("Opsi jawaban tidak ditemukan.");
      const checked = option.getAttribute("aria-checked") === "true";
      if (action === "checked") return checked;
      if (checked) return null;
      option.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = option.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    } else if (kind === "dropdown") {
      const options = await listOptions(nodes[0]);
      const option = options.find(node => optionLabel(node) === answer);
      if (!option) throw new Error("Opsi dropdown tidak ditemukan.");
      option.click();
    } else if (kind !== "unsupported") {
      const input = nodes[0];
      input.focus();
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, answer);
      if (input.value !== answer && !input.value) throw new Error("Format jawaban tidak diterima.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    } else throw new Error("Tipe pertanyaan belum didukung.");
    return true;
  }
  const questions = cards.map(card => {
    const { kind, nodes } = controls(card);
    const heading = card.querySelector('[role="heading"]');
    const options = kind === "dropdown"
      ? [...nodes[0].querySelectorAll('[role="option"][data-value]:not([data-value=""])')].map(optionLabel)
      : ["radio", "checkbox"].includes(kind) ? nodes.filter(node => node.getAttribute("data-value") !== "__other_option__").map(optionLabel) : [];
    return {
      title: titleFor(card) || "Pertanyaan tanpa judul",
      kind, options: [...new Set(options)],
      required: !!card.querySelector('[aria-required="true"],[required],.vnumgf') || /\*\s*$/.test(label(heading)),
    };
  });
  const history = form?.querySelector('[name="pageHistory"]')?.value ?? "";
  return {
    url: location.href,
    title: label(document.querySelector('[role="heading"][aria-level="1"]')) || document.title,
    key: JSON.stringify([performance.timeOrigin, history, questions.map(question => question.title), !!next, !!submit]),
    next: !!next,
    submit: !!submit,
    questions,
    errors: cards.map(card => all(card, '[role="alert"]').map(label).filter(Boolean).join(" ")),
    confirmed: !next && !submit && (
      !!document.querySelector(".vHW8K") ||
      /your response has been recorded|respons anda telah direkam|jawaban anda telah direkam/i.test(document.body?.innerText ?? "")
    ),
  };
}`;

function read(browser: Browser) {
  return browser.evaluate<Snapshot | null>(formDom, ["read"]).catch(error => {
    if (/execution context|navigat|inspected target/i.test((error as Error).message)) return null;
    throw error;
  });
}

function placeholder(question: Question): Answer {
  if (question.kind === "checkbox") return question.options;
  if (question.options.length) return question.options[0];
  if (question.kind === "date") return "2000-01-01";
  if (question.kind === "time") return "12:00";
  if (question.kind === "text") {
    if (/e.?mail/i.test(question.title)) return "test@example.com";
    if (/\b(umur|usia|age|jumlah|angka)\b/i.test(question.title)) return "25";
    return "test";
  }
  throw new Error("Tipe pertanyaan wajib belum didukung atau opsi tidak ditemukan.");
}

async function fill(browser: Browser, question: Question, index: number, answer: Answer) {
  if (question.kind === "radio" || question.kind === "checkbox") {
    for (const option of Array.isArray(answer) ? answer : [answer]) {
      let checked = false;
      for (let attempt = 0; attempt < 3 && !checked; attempt++) {
        const point = await browser.evaluate<{ x: number; y: number } | null>(formDom, ["answer", index, option]);
        if (!point) {
          checked = true;
          break;
        }
        await browser.click(point.x, point.y);
        await sleep(200);
        checked = await browser.evaluate<boolean>(formDom, ["checked", index, option]);
      }
      if (!checked) throw new Error(`Opsi “${option}” belum terpilih setelah tiga percobaan.`);
    }
    return;
  }
  await browser.evaluate(formDom, ["answer", index, answer]);
}

export type Log = (message: string) => void;

export async function walk(browser: Browser, url: string, mode: "scan" | "test" | "batch",
  log: Log, expected?: Form, row?: Row, shouldStop = () => false, showProgress = mode !== "batch"): Promise<Form> {
  const ensureActive = () => { if (shouldStop()) throw new Error("Dihentikan pengguna."); };
  const questions: Question[] = [];
  ensureActive();
  log("Membuka form");
  await browser.navigate(url);
  let screen = await waitFor(async () => {
    const snapshot = await read(browser);
    return snapshot && (snapshot.next || snapshot.submit) ? snapshot : undefined;
  }, "Form tidak bisa dibuka. Cek akses, koneksi, dan bahasa form (Indonesia atau Inggris).");
  const { title } = screen;
  for (let page = 1; page <= 100; page++) {
    ensureActive();
    let signature = "";
    let stableSince = 0;
    screen = await waitFor(async () => {
      ensureActive();
      const current = await read(browser);
      if (!current || (!current.next && !current.submit)) {
        signature = "";
        return;
      }
      const state = JSON.stringify([current.key, current.questions]);
      if (state !== signature) {
        signature = state;
        stableSince = Date.now();
        return;
      }
      if (Date.now() - stableSince >= 650) return current;
    }, `Halaman ${page} · pertanyaan belum selesai dimuat.`);
    log(`Halaman ${page} · membaca pertanyaan`);
    const known = expected?.questions.filter(question => question.page === page);
    if (expected && (known?.length !== screen.questions.length ||
        known.some((question, index) => question.title !== screen.questions[index].title ||
          question.kind !== screen.questions[index].kind || (!question.required && screen.questions[index].required) ||
          question.options.length !== screen.questions[index].options.length ||
          question.options.some(option => !screen.questions[index].options.includes(option))) ||
        screen.next !== (page < expected.pages) || screen.submit !== (page === expected.pages))) {
      throw new Error(`Halaman ${page} · struktur form berubah. Scan ulang.`);
    }
    const attempted = new Set<number>();
    for (const [index, item] of screen.questions.entries()) {
      ensureActive();
      const question = { ...item, id: questions.length + 1, page };
      questions.push(question);
      const context = `Halaman ${page} · Q${question.id} “${question.title}”`;
      try {
        const answer = mode === "scan"
          ? item.kind === "unsupported" ? undefined : placeholder(question)
          : row?.[question.id];
        if (!answer?.length) continue;
        attempted.add(index);
        log(`${context} · mengisi jawaban`);
        await fill(browser, question, index, answer);
        if (showProgress) await sleep(450);
      } catch (error) {
        throw new Error(`${context} · ${(error as Error).message}`);
      }
    }

    ensureActive();
    if (screen.submit && !screen.next) {
      if (mode === "test") {
        const after = await read(browser);
        const invalid = after?.errors.findIndex(Boolean) ?? -1;
        if (after && invalid >= 0) throw new Error(`Halaman ${page} · Q${questions.length - screen.questions.length + invalid + 1} · ${after.errors[invalid]}`);
      }
      if (mode === "scan") await sleep(900);
      ensureActive();
      return { url, title, pages: page, questions };
    }
    if (!screen.next || screen.submit) throw new Error(`Halaman ${page} · tombol navigasi tidak dikenali.`);
    if (mode === "scan") await sleep(650);
    ensureActive();
    log(`Halaman ${page} · klik Berikutnya`);
    await browser.evaluate(formDom, ["next"]);
    const previous = screen.key;
    const firstQuestion = questions.length - screen.questions.length + 1;
    screen = await waitFor(async () => {
      ensureActive();
      const next = await read(browser);
      if (!next) return;
      if (next.key !== previous && (next.next || next.submit)) return next;
      const invalid = next.errors.findIndex(Boolean);
      if (invalid < 0) return;
      const context = `Halaman ${page} · Q${firstQuestion + invalid} “${next.questions[invalid].title}”`;
      if (mode === "scan" && !attempted.has(invalid) && /wajib|required/i.test(next.errors[invalid])) {
        attempted.add(invalid);
        const question = questions[firstQuestion + invalid - 1];
        question.required = true;
        log(`${context} · Google Forms meminta jawaban, mengisi placeholder dan mencoba Berikutnya lagi`);
        try {
          await fill(browser, question, invalid, placeholder(question));
          await sleep(450);
          ensureActive();
          await browser.evaluate(formDom, ["next"]);
        } catch (error) {
          throw new Error(`${context} · ${(error as Error).message}`);
        }
        return;
      }
      throw new Error(`${context} · ${next.errors[invalid]}`);
    }, `Halaman ${page} · gagal lanjut setelah klik Berikutnya.`);
  }
  throw new Error("Form melebihi 100 halaman atau navigasinya berulang.");
}

export class RejectedResponse extends Error {}

export async function submit(browser: Browser, form: Form) {
  await browser.evaluate(formDom, ["submit"]);
  await waitFor(async () => {
    const screen = await read(browser);
    if (screen?.confirmed) return true;
    const invalid = screen?.errors.findIndex(Boolean) ?? -1;
    if (screen?.submit && invalid >= 0) {
      const question = form.questions.filter(item => item.page === form.pages)[invalid];
      throw new RejectedResponse(`Halaman ${form.pages} · Q${question?.id ?? "?"} “${question?.title ?? ""}” · ${screen.errors[invalid]}`);
    }
  }, "Konfirmasi Google Forms belum muncul.");
}

export { openEdge, sleep };
