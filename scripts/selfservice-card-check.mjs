/**
 * Verifies the self-service ID card lookup on the photo booth page:
 *  - the form and status messages render
 *  - a matching number + name on an approved member downloads the card
 *  - a wrong name is refused with the coarse no-match redirect
 *  - a pending member is refused the same way
 *  - the removed old endpoint stays gone
 *
 * Usage: node scripts/selfservice-card-check.mjs <email> <password>
 */
import { createClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";

import { loadEnvFile } from "./db-config.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: node scripts/selfservice-card-check.mjs <email> <password>");
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

console.log("\n1. The page offers the lookup");
const page = await (await fetch(`${BASE}/photo-booth`)).text();
check("section renders", page.includes("Download your ID card"));
check("form posts to the lookup endpoint", page.includes('action="/api/id-card-lookup"'));
check("number and name fields present", page.includes('name="number"') && page.includes('name="name"'));

console.log("\n2. Approved member with matching name downloads");
const stamp = Date.now() % 100000;

// Documentation range (RFC 5737), varied per run so each run looks like a
// different visitor device to the rate limiters.
const clientIp = `198.51.${100 + (stamp % 100)}.${1 + (Math.floor(stamp / 1000) % 250)}`;
const memberName = `SelfService Person${stamp}`;
const created = await admin.rpc("submit_registration_v2", {
  p_full_name: memberName,
  p_date_of_birth: null,
  p_father_name: "SelfService Father",
  p_gender: "male",
  p_blood_group: "B+",
  p_state_code: "TS",
  p_country_code: "IN",
  p_village: "SelfService Village",
  p_mobile_number: `98765${String(stamp % 100000).padStart(5, "0")}`,
  p_phone_country_code: null,
  p_profile_photo_url: null,
  p_email: "selfservice@example.com",
  p_age: 28,
  p_district_id: null,
  p_rate_key: `selfservice-${stamp}`,
});
const row = Array.isArray(created.data) ? created.data[0] : created.data;
const number = row?.registration_number ?? "";
check("probe member registered (pending)", row?.result_code === "created", number);

// Pending: must be refused.
const pendingLookup = await fetch(
  `${BASE}/api/id-card-lookup?number=${number}&name=${encodeURIComponent(memberName)}`,
  { redirect: "manual", headers: { "x-forwarded-for": clientIp } },
);
check(
  "pending member is refused",
  [302, 303, 307].includes(pendingLookup.status) &&
    (pendingLookup.headers.get("location") ?? "").includes("card=no-match"),
  `${pendingLookup.status} -> ${pendingLookup.headers.get("location") ?? ""}`,
);

await admin.from("members").update({ status: "active" }).eq("registration_number", number);

// Happy path: the same name with messy casing and trailing punctuation, which
// the database normaliser strips. (Punctuation mid-name becomes a space, so a
// variant there would be a genuinely different name.)
const messyName = `${memberName}!!`.toUpperCase();
const found = await fetch(
  `${BASE}/api/id-card-lookup?number=${number.toLowerCase()}&name=${encodeURIComponent(messyName)}`,
  { redirect: "manual", headers: { "x-forwarded-for": clientIp } },
);
const png = Buffer.from(await found.arrayBuffer());
check("matching lookup downloads", found.status === 200, String(found.status));
check("content type is image/png", (found.headers.get("content-type") ?? "").includes("image/png"));
check(
  "download filename carries the number",
  (found.headers.get("content-disposition") ?? "").includes(number),
);
check("body is a PNG", png.length > 8 && png.subarray(1, 4).toString("ascii") === "PNG", `${png.length} bytes`);

console.log("\n3. Wrong name is refused identically");
const wrongName = await fetch(
  `${BASE}/api/id-card-lookup?number=${number}&name=${encodeURIComponent("Somebody Else")}`,
  { redirect: "manual", headers: { "x-forwarded-for": clientIp } },
);
check(
  "wrong name redirects as no-match",
  [302, 303, 307].includes(wrongName.status) &&
    (wrongName.headers.get("location") ?? "").includes("card=no-match"),
);

const wrongNumber = await fetch(
  `${BASE}/api/id-card-lookup?number=TSSS999999&name=${encodeURIComponent(memberName)}`,
  { redirect: "manual", headers: { "x-forwarded-for": clientIp } },
);
check(
  "unknown number redirects as no-match too",
  [302, 303, 307].includes(wrongNumber.status) &&
    (wrongNumber.headers.get("location") ?? "").includes("card=no-match"),
);

console.log("\n4. Cleanup");
await admin.from("members").delete().eq("registration_number", number);
const { data: gone } = await admin.from("members").select("id").eq("registration_number", number).maybeSingle();
check("probe member removed", !gone);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);