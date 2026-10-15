/**
 * Verifies the member approval workflow end to end:
 *  - a new registration enters as pending, not active
 *  - approving flips the status and attempts the ID card email
 *  - without SMTP configured the approval still succeeds with a clear message
 *  - re-approving resends instead of failing
 *
 * Usage: node scripts/member-approval-check.mjs <email> <password>
 */
import { createClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";

import { loadEnvFile } from "./db-config.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ORIGIN = new URL(BASE).origin;
const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: node scripts/member-approval-check.mjs <email> <password>");
  process.exit(1);
}

const env = loadEnvFile();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: WebSocket },
  auth: { persistSession: false },
});

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

async function signIn() {
  const html = await (await fetch(`${BASE}/admin/login`)).text();
  const body = new FormData();
  for (const match of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(match[0])?.[1];
    const value = /value="([^"]*)"/.exec(match[0])?.[1] ?? "";
    if (name) body.append(name, decode(value));
  }
  body.set("email", email);
  body.set("password", password);
  body.set("next", "/admin");

  const response = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    body,
    redirect: "manual",
    headers: { origin: ORIGIN, host: new URL(BASE).host },
  });

  return (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(";")[0]).join("; ");
}

/** Posts a server action replaying the target form's envelope. */
async function postAction(route, marker, values) {
  const html = await (await fetch(`${BASE}${route}`, { headers: { cookie } })).text();
  const form =
    [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)]
      .map((match) => match[0])
      .find((candidate) => candidate.includes(`name="${marker}"`)) ?? "";

  const body = new FormData();
  for (const match of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(match[0])?.[1];
    const value = /value="([^"]*)"/.exec(match[0])?.[1] ?? "";
    if (name && !/^\$ACTION_ID_/.test(name)) body.append(name, decode(value));
  }
  for (const [name, value] of Object.entries(values)) {
    body.delete(name);
    body.append(name, value);
  }

  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    body,
    redirect: "manual",
    headers: { origin: ORIGIN, host: new URL(BASE).host, cookie },
  });
  return (await response.text()).replace(/<!--[\s\S]*?-->/g, "");
}

const cookie = await signIn();
check("signed in", Boolean(cookie));

console.log("\n1. Registration enters as pending");
const stamp = Date.now() % 100000;
const memberName = `Approval Person${stamp}`;
const registerHtml = await (await fetch(`${BASE}/register`)).text();
const registerForm =
  [...registerHtml.matchAll(/<form\b[\s\S]*?<\/form>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes('name="fullName"')) ?? "";

const registerBody = new FormData();
for (const match of registerForm.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
  const name = /name="([^"]+)"/.exec(match[0])?.[1];
  const value = /value="([^"]*)"/.exec(match[0])?.[1] ?? "";
  if (name && !/^\$ACTION_ID_/.test(name)) registerBody.append(name, decode(value));
}
for (const [name, value] of Object.entries({
  fullName: memberName,
  fatherName: "Approval Father",
  dateOfBirth: "1990-06-06",
  gender: "male",
  bloodGroup: "A+",
  countryCode: "IN",
  stateCode: "TS",
  village: "Approval Village",
  mobileNumber: `98654${String(stamp).padStart(5, "0")}`,
  email: "approval-probe@example.com",
  website: "",
})) {
  registerBody.delete(name);
  registerBody.append(name, value);
}

const registerResponse = await fetch(`${BASE}/register`, {
  method: "POST",
  body: registerBody,
  redirect: "manual",
  headers: {
    origin: ORIGIN,
    host: new URL(BASE).host,
    "x-forwarded-for": `198.51.${100 + (stamp % 100)}.7`,
  },
});
check("registration succeeds", registerResponse.status === 200, String(registerResponse.status));

const { data: created } = await admin
  .from("members")
  .select("id, registration_number, status, email")
  .eq("full_name", memberName)
  .maybeSingle();
check("member row created", Boolean(created));
check("new member is pending, not active", created?.status === "pending", created?.status ?? "(missing)");

console.log("\n2. Approval activates and attempts the email");
const approveText = await postAction(
  `/admin/registrations?view=member&id=${created.id}`,
  "memberId",
  { memberId: created.id },
);
check(
  "approval reports success",
  /now an active member|was approved/i.test(approveText),
  approveText.slice(0, 200),
);
check(
  "unconfigured SMTP is reported honestly",
  /could not be sent|SMTP/i.test(approveText),
  "expected a clear email-skipped message",
);

const { data: approved } = await admin
  .from("members")
  .select("status")
  .eq("id", created.id)
  .maybeSingle();
check("status flipped to active", approved?.status === "active", approved?.status ?? "(missing)");

console.log("\n3. Re-approval resends instead of failing");
const resendText = await postAction(
  `/admin/registrations?view=member&id=${created.id}`,
  "memberId",
  { memberId: created.id },
);
check("resend is offered", /fresh ID card was emailed|email could not be sent/i.test(resendText));

console.log("\n4. Audit trail");
const { data: audit } = await admin
  .from("audit_logs")
  .select("action")
  .eq("entity", "members")
  .eq("entity_id", created.id)
  .order("created_at", { ascending: false })
  .limit(3);
check(
  "approval audited",
  (audit ?? []).some((row) => row.action === "approve_member"),
  JSON.stringify(audit ?? []),
);

console.log("\n5. Cleanup");
await admin.from("members").delete().eq("id", created.id);
await admin.from("audit_logs").delete().eq("entity_id", created.id);
const { data: gone } = await admin.from("members").select("id").eq("id", created.id).maybeSingle();
check("probe member removed", !gone);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);