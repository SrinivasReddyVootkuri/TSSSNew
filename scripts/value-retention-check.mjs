/**
 * Verifies that a validation failure keeps what the visitor typed.
 * Submits the registration form with the name missing but everything else
 * filled, then asserts the rendered inputs carry the submitted values.
 *
 * Usage: node scripts/value-retention-check.mjs
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ORIGIN = new URL(BASE).origin;

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

function decode(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function readForm(html) {
  const form = /<form\b[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
  const hidden = [];
  for (const tag of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(tag[0])?.[1];
    const value = /value="([^"]*)"/.exec(tag[0])?.[1] ?? "";
    if (name && !/^\$ACTION_ID_/.test(name)) hidden.push([name, decode(value)]);
  }
  return { form, hidden };
}

const html = await (await fetch(`${BASE}/register`)).text();
const { form, hidden } = readForm(html);

const body = new FormData();
for (const [name, value] of hidden) body.append(name, value);
// Name intentionally left empty — that is the validation failure.
for (const [name, value] of Object.entries({
  fullName: "",
  fatherName: "Retention Father",
  age: "44",
  bloodGroup: "AB+",
  countryCode: "IN",
  stateCode: "TS",
  districtId: (/<option value="([0-9a-f-]{36})">/.exec(html) ?? [])[1] ?? "",
  village: "Retention Village",
  mobileNumber: "9876505555",
  email: "retain@example.com",
  website: "",
})) {
  body.delete(name);
  body.append(name, value);
}

const response = await fetch(`${BASE}/register`, {
  method: "POST",
  body,
  redirect: "manual",
  headers: { origin: ORIGIN, host: new URL(BASE).host, "x-forwarded-for": "198.51.100.77" },
});
const text = (await response.text()).replace(/<!--[\s\S]*?-->/g, "");

console.log(`response: ${response.status}`);
check("validation error is shown", text.includes("Please correct the highlighted fields"));

// React's post-submit reset restores inputs to their (now echoed) defaults.
check("father's name retained", /name="fatherName"[^>]*value="Retention Father"|value="Retention Father"[^>]*name="fatherName"/.test(text));
check("village retained", /value="Retention Village"/.test(text));
check("age retained", /value="44"/.test(text));
check("mobile retained", /value="9876505555"/.test(text));
check("blood group retained", /value="AB\+"/.test(text));
check("email retained", /value="retain@example\.com"/.test(text));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);