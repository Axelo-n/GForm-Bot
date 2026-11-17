import type { Config, Form } from "./plan";

export type ScanRecord = { id: string; savedAt: string; form: Form };
export type SavedSettings = { version: 1; form: Form; config: Config };
export type Workspace = { scans: ScanRecord[]; latest: SavedSettings | null };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function answer(value: unknown) {
  return typeof value === "string" || strings(value);
}

function questionId(key: string) {
  return /^[1-9]\d*$/.test(key);
}

function between(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function parseForm(value: unknown): Form {
  if (!object(value) || typeof value.url !== "string" || typeof value.title !== "string" ||
      !between(value.pages, 1, 100) || !Number.isInteger(value.pages) || !Array.isArray(value.questions) ||
      !value.questions.every((q, index) => object(q) && q.id === index + 1 &&
        between(q.page, 1, Number(value.pages)) && Number.isInteger(q.page) &&
        typeof q.title === "string" && typeof q.required === "boolean" && strings(q.options) &&
        typeof q.kind === "string" && ["text", "radio", "checkbox", "dropdown", "date", "time", "unsupported"].includes(q.kind))) {
    throw new Error("Struktur JSON hasil scan tidak valid.");
  }
  return value as unknown as Form;
}

export function parseConfig(value: unknown): Config {
  if (!object(value) || (value.mode !== "independent" && value.mode !== "packages") ||
      !between(value.count, 1, 10000) || !Number.isInteger(value.count) ||
      !between(value.workers, 1, 10) || !Number.isInteger(value.workers) ||
      !between(value.min, 0, 3600) || !between(value.max, value.min, 3600) ||
      !object(value.rules) || !Array.isArray(value.packages) ||
      (value.packageQuestions !== undefined && (!Array.isArray(value.packageQuestions) ||
        !value.packageQuestions.every(id => typeof id === "number" && Number.isSafeInteger(id) && id > 0))) ||
      !Object.entries(value.rules).every(([id, rules]) => questionId(id) && Array.isArray(rules) &&
        rules.every(rule => object(rule) && answer(rule.answer) && between(rule.weight, 0, 100))) ||
      !value.packages.every(pack => object(pack) && between(pack.weight, 0, 100) &&
        object(pack.row) && Object.entries(pack.row).every(([id, item]) => questionId(id) && answer(item)))) {
    throw new Error("Struktur JSON setting tidak valid. Unduh contoh lewat Download setting JSON.");
  }
  return value as unknown as Config;
}

export function parseSettings(value: unknown): SavedSettings {
  if (!object(value) || value.version !== 1) throw new Error("Versi JSON setting tidak dikenali.");
  return { version: 1, form: parseForm(value.form), config: parseConfig(value.config) };
}

export function sameForm(a: Form, b: Form) {
  const signature = (form: Form) => JSON.stringify([form.pages, form.questions.map(q =>
    [q.id, q.page, q.title, q.kind, q.required, q.options])]);
  return a.url === b.url && signature(a) === signature(b);
}

export function importedConfig(value: unknown, form?: Form) {
  if (object(value) && "config" in value) {
    const saved = parseSettings(value);
    return { form: form && sameForm(form, saved.form) ? form : saved.form, config: saved.config };
  }
  if (!form) throw new Error("Buka hasil scan dulu untuk impor JSON setting tanpa metadata form.");
  return { form, config: parseConfig(value) };
}
