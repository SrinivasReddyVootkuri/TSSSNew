import { buildIdCardAssets, toIdCardMember } from "@/lib/idcard/assets";
import { idCardFileName, renderIdCardPng } from "@/lib/idcard/render-id-card";
import { createAdminClient } from "@/lib/supabase/server";
import { clientIdentifier } from "@/lib/security/rate-limit";

/**
 * Self-service identity card download from the photo booth page.
 *
 * A plain GET form works without JavaScript: the visitor gives their
 * registration number and full name, and the database function (migration
 * 0015) decides whether both match an approved member. Any other outcome
 * redirects back to the photo booth page with a coarse reason code — a wrong
 * name and an unknown number look identical, so guessing numbers reveals
 * nothing.
 */
const REASONS: Record<string, string> = {
  not_found: "no-match",
  rate_limited: "slow-down",
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const number = url.searchParams.get("number") ?? "";
  const name = url.searchParams.get("name") ?? "";

  const back = `${url.origin}/photo-booth#id-card`;

  if (!number.trim() || !name.trim()) {
    return Response.redirect(`${back}?card=missing`, 303);
  }

  const identifier = clientIdentifier(request.headers);
  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc("lookup_member_id_card", {
    p_registration_number: number.trim().toUpperCase(),
    p_full_name: name,
    p_rate_key: identifier,
  });

  if (error) {
    console.error("id card lookup failed:", error.message);
    return Response.redirect(`${back}?card=error`, 303);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const code = String(row?.result_code ?? "not_found");

  if (code !== "found" || !row?.registration_number) {
    return Response.redirect(`${back}?card=${REASONS[code] ?? "no-match"}`, 303);
  }

  try {
    const { data: settings } = await supabase
      .from("site_settings")
      .select("contact_phone, contact_email")
      .limit(1)
      .maybeSingle();

    const assets = await buildIdCardAssets(row.profile_photo_url, {
      phone: settings?.contact_phone ?? null,
      email: settings?.contact_email ?? null,
    });

    const idCardMember = toIdCardMember(row);
    const png = await renderIdCardPng(idCardMember, assets);

    return new Response(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        "content-disposition": `attachment; filename="${idCardFileName(idCardMember)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("id card render failed:", error);
    return Response.redirect(`${back}?card=error`, 303);
  }
}
