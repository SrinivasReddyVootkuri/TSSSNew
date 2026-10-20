import { readFileSync, writeFileSync } from "node:fs";

/**
 * Binds echoed submission values to a form's inputs as defaultValue, so
 * React's post-submit reset restores what the visitor typed.
 * Usage: node scripts/bind-values.mjs <file> <id1,id2,...>
 */
const [file, idList] = process.argv.slice(2);
if (!file || !idList) {
  console.error("Usage: node scripts/bind-values.mjs <file> <comma-separated-input-ids>");
  process.exit(1);
}

let text = readFileSync(file, "utf8");

if (!text.includes("const values = (state.values")) {
  text = text.replace(
    /const errors = \(state\.errors \?\? \{\}\) as Record<string, string>;/,
    "const errors = (state.errors ?? {}) as Record<string, string>;\n  const values = (state.values ?? {}) as Record<string, string>;",
  );
}

let inputsBound = 0;
let selectsBound = 0;

for (const pair of idList.split(",").map((entry) => entry.trim()).filter(Boolean)) {
  const [id, field] = pair.includes("=") ? pair.split("=") : [pair, pair];
  const fallback = field === "stateCode" ? ' ?? "TS"' : ' ?? ""';

  // Text/number/date inputs: add defaultValue on its own line above the id.
  const inputPattern = new RegExp(`(<Input\\n(\\s+))id="${id}"`);
  if (inputPattern.test(text)) {
    text = text.replace(inputPattern, `$1defaultValue={values.${field}${fallback}}\n$2id="${id}"`);
    inputsBound += 1;
    continue;
  }

  // Single-line inputs: add defaultValue inside the tag.
  const inlinePattern = new RegExp(`(<Input id="${id}" )`);
  if (inlinePattern.test(text)) {
    text = text.replace(inlinePattern, `$1defaultValue={values.${field}${fallback}} `);
    inputsBound += 1;
    continue;
  }

  // Textareas: same treatment as inputs.
  const textareaPattern = new RegExp(`(<Textarea\\n(\\s+))id="${id}"`);
  if (textareaPattern.test(text)) {
    text = text.replace(textareaPattern, `$1defaultValue={values.${field}${fallback}}\n$2id="${id}"`);
    inputsBound += 1;
    continue;
  }

  // Selects: replace their existing defaultValue.
  const selectPattern = new RegExp(`(<Select id="${id}"[^>]*?)defaultValue="[^"]*"`);
  if (selectPattern.test(text)) {
    text = text.replace(selectPattern, `$1defaultValue={values.${field}${fallback}}`);
    selectsBound += 1;
    continue;
  }

  console.log(`MISS ${id}`);
}

writeFileSync(file, text);
console.log(`inputs bound: ${inputsBound}, selects bound: ${selectsBound}`);