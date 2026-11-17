export type Question = {
  id: number;
  page: number;
  title: string;
  kind: "text" | "radio" | "checkbox" | "dropdown" | "date" | "time" | "unsupported";
  options: string[];
  required: boolean;
};

export type Form = { url: string; title: string; pages: number; questions: Question[] };
export type Answer = string | string[];
export type Row = Record<number, Answer>;
export type Weighted = { answer: Answer; weight: number };
export type Config = {
  count: number;
  mode: "independent" | "packages";
  rules: Record<number, Weighted[]>;
  packages: { row: Row; weight: number }[];
  packageQuestions?: number[];
  min: number;
  max: number;
  workers: number;
};

function shuffle<T>(items: T[]) {
  for (let index = items.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

function distribute<T>(items: { value: T; weight: number }[], count: number) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (!Number.isFinite(total) || Math.abs(total - 100) > 0.000001 ||
      items.some(item => !Number.isFinite(item.weight) || item.weight < 0)) {
    throw new Error("Total persentase harus 100%.");
  }
  const quotas = items.map(item => {
    const exact = item.weight / total * count;
    return { value: item.value, amount: Math.floor(exact), remainder: exact % 1 };
  });
  let remaining = count - quotas.reduce((sum, item) => sum + item.amount, 0);
  for (const item of shuffle(quotas).sort((a, b) => b.remainder - a.remainder)) {
    if (remaining-- <= 0) break;
    item.amount++;
  }
  return shuffle(quotas.flatMap(item => Array<T>(item.amount).fill(item.value)));
}

function check(question: Question, answer: Answer | undefined) {
  const fail = (reason: string) => { throw new Error(`Q${question.id} “${question.title}” · ${reason}`); };
  if (answer === undefined || answer === "" || (Array.isArray(answer) && answer.length === 0)) {
    if (question.required) fail("Jawaban wajib diisi.");
    return;
  }
  if (question.kind === "unsupported") fail("Tipe pertanyaan belum didukung.");
  if (question.kind === "checkbox") {
    if (!Array.isArray(answer) || new Set(answer).size !== answer.length ||
        answer.some(value => !question.options.includes(value))) fail("Kombinasi checkbox tidak valid.");
    return;
  }
  if (typeof answer !== "string") return fail("Jawaban harus satu nilai.");
  if (["radio", "dropdown"].includes(question.kind) && !question.options.includes(answer)) fail("Opsi tidak ditemukan.");
  if (question.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(answer)) fail("Pakai format YYYY-MM-DD.");
  if (question.kind === "time" && !/^\d{2}:\d{2}$/.test(answer)) fail("Pakai format HH:MM.");
}

export function makePlan(form: Form, config: Config): Row[] {
  const { count, workers, min, max } = config;
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("Jumlah respons harus 1–10.000.");
  if (!Number.isInteger(workers) || workers < 1 || workers > 10) throw new Error("Pekerja paralel harus 1–10.");
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 3600) {
    throw new Error("Rentang jeda harus 0–3600 detik, minimum ≤ maksimum.");
  }
  const packaged = config.mode === "packages"
    ? form.questions.filter(question => config.packageQuestions?.includes(question.id) ?? true)
    : [];
  let rows: Row[] = Array.from({ length: count }, () => ({}));
  if (packaged.length) {
    for (const pack of config.packages.filter(pack => pack.weight > 0)) {
      for (const question of packaged) check(question, pack.row[question.id]);
    }
    rows = distribute(config.packages.map(pack => ({
      value: Object.fromEntries(packaged.map(question => [question.id, pack.row[question.id]])),
      weight: pack.weight,
    })), count).map(row => ({ ...row }));
  }

  for (const question of form.questions) {
    if (packaged.includes(question)) continue;
    const rules = config.rules[question.id] ?? [];
    const blank = question.kind === "checkbox" ? [] : "";
    try {
      for (const rule of rules.filter(rule => rule.weight > 0 || !question.options.length)) {
        check(question, rule.answer);
      }
      let answers: Answer[];
      if (!rules.length) {
        check(question, blank);
        answers = Array<Answer>(count).fill(blank);
      } else if (question.options.length) {
        answers = distribute(rules.map(rule => ({ value: rule.answer, weight: rule.weight })), count);
      } else {
        const pool = rules.map(rule => rule.answer);
        answers = pool.length >= count
          ? shuffle(pool).slice(0, count)
          : Array.from({ length: count }, () => pool[Math.floor(Math.random() * pool.length)]);
      }
      rows.forEach((row, index) => { row[question.id] = answers[index]; });
    } catch (error) {
      const message = (error as Error).message;
      throw new Error(message.startsWith("Q") ? message : `Q${question.id} “${question.title}” · ${message}`);
    }
  }
  return rows;
}
