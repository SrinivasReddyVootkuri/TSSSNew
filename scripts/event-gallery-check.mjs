/**
 * Proves the event gallery flow end to end on a chosen event: uploads a real
 * file through the admin form action, confirms the public page renders it
 * under a Gallery heading, then removes the probe row again.
 *
 * Usage: node scripts/event-gallery-check.mjs <email> <password> <event-slug>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";

import { loadEnvFile } from "./db-config.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ORIGIN = new URL(BASE).origin;
const [email, password, eventSlug] = process.argv.slice(2);

if (!email || !password || !eventSlug) {
  console.error("Usage: node scripts/event-gallery-check.mjs <email> <password> <event-slug>");
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

const cookie = await signIn();
check("signed in", Boolean(cookie));

const { data: event } = await admin
  .from("events")
  .select("id, title, category_id, event_categories!inner(slug)")
  .eq("slug", eventSlug)
  .maybeSingle();

check("event found", Boolean(event), eventSlug);
const category = event.event_categories.slug;

console.log("\n1. Upload through the admin form");
const galleryHtml = await (
  await fetch(`${BASE}/admin/events/galleries?event=${event.id}`, { headers: { cookie } })
).text();
const form =
  [...galleryHtml.matchAll(/<form\b[\s\S]*?<\/form>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes('name="__intent"')) ?? "";

const fields = new Map();
for (const match of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
  const name = /name="([^"]+)"/.exec(match[0])?.[1];
  const value = /value="([^"]*)"/.exec(match[0])?.[1] ?? "";
  if (name && !/^\$ACTION_ID_/.test(name)) fields.set(name, decode(value));
}

const png = await readFile(path.join(process.cwd(), "public", "brand", "tsss-emblem.png"));
const body = new FormData();
for (const [name, value] of fields) body.append(name, value);
body.delete("event_id");
body.append("event_id", event.id);
body.delete("caption");
body.append("caption", "Gallery probe");
body.delete("image_url");
body.append("image_url", "");
body.delete("display_order");
body.append("display_order", "1");
body.append("image_urlFile", new Blob([png], { type: "image/png" }), "probe.png");

const upload = await fetch(`${BASE}/admin/events/galleries`, {
  method: "POST",
  body,
  redirect: "manual",
  headers: { origin: ORIGIN, host: new URL(BASE).host, cookie },
});
const uploadText = (await upload.text()).replace(/<!--[\s\S]*?-->/g, "");
check("upload accepted", !/highlighted fields|upload failed|not a valid image/i.test(uploadText));

const { data: rows } = await admin
  .from("event_gallery")
  .select("id, image_url")
  .eq("event_id", event.id)
  .eq("caption", "Gallery probe");
check("row stored", (rows ?? []).length === 1);

console.log("\n2. Public page renders it");
const page = await (
  await fetch(`${BASE}/events/${category}/${eventSlug}`)
).text();
check("Gallery heading present", page.includes(">Gallery<"));
check("caption present", page.includes("Gallery probe"));

const imageUrl = rows?.[0]?.image_url ?? "";
if (imageUrl.startsWith("http")) {
  try {
    const image = await fetch(imageUrl);
    check("stored image loads", image.status === 200, String(image.status));
  } catch {
    check("stored image loads", false, "fetch failed");
  }
}

console.log("\n3. Cleanup");
for (const row of rows ?? []) {
  await admin.from("event_gallery").delete().eq("id", row.id);
  const urlPath = new URL(row.image_url).pathname.split("/public-media/")[1];
  if (urlPath) await admin.storage.from("public-media").remove([urlPath]);
}
const { count } = await admin
  .from("event_gallery")
  .select("id", { count: "exact", head: true })
  .eq("caption", "Gallery probe");
check("probe removed", (count ?? 0) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);