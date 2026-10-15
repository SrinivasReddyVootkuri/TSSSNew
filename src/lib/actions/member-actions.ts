"use server";

import { revalidatePath } from "next/cache";

import { writeAudit } from "@/lib/actions/admin-actions";
import type { AdminState } from "@/lib/actions/state";
import { getAdminSession, roleRank } from "@/lib/auth/session";
import { buildIdCardAssets, toIdCardMember } from "@/lib/idcard/assets";
import { idCardFileName, renderIdCardPng } from "@/lib/idcard/render-id-card";
import { sendSmtpMail } from "@/lib/notifications/smtp";
import { createAdminClient } from "@/lib/supabase/server";
import { countryName, stateName } from "@/lib/lookups";

/**
 * Approves a pending member: flips them to active and emails their identity
 * card with the auto-generated registration number.
 *
 * Doubles as a re-send: approving an already active member skips the status
 * change and just emails a fresh card. Either way the administrator gets a
 * message saying exactly what happened, because a silent email failure would
 * leave everyone assuming the member was informed.
 */
export async function approveMemberAction(
  _previous: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const memberId = String(formData.get("memberId") ?? "").trim();

  if (!memberId) {
    return { status: "error", message: "No member was selected." };
  }

  const session = await getAdminSession();
  if (!session) {
    return { status: "error", message: "Your session expired. Please sign in again." };
  }
  if (roleRank(session.user.role) < roleRank("content_manager")) {
    return { status: "error", message: "You do not have permission to do that." };
  }

  const supabase = createAdminClient();

  const { data: member, error: memberError } = await supabase
    .from("members")
    .select(
      "id, registration_number, full_name, father_name, designation, date_of_birth, gender, blood_group, mobile_number, phone_country_code, village, state_code, country_code, profile_photo_url, email, status",
    )
    .eq("id", memberId)
    .maybeSingle();

  if (memberError || !member) {
    return { status: "error", message: "That member could not be found. They may have been removed." };
  }

  const wasPending = member.status === "pending";

  if (wasPending) {
    const { error: statusError } = await supabase
      .from("members")
      .update({ status: "active" })
      .eq("id", member.id);

    if (statusError) {
      console.error("member approval failed:", statusError.message);
      return { status: "error", message: "The member could not be approved. Please try again." };
    }
  }

  await writeAudit(wasPending ? "approve_member" : "resend_id_card", "members", member.id, null, {
    registration_number: member.registration_number,
    email: member.email,
  });

  if (!member.email) {
    revalidatePath("/admin/registrations");
    return {
      status: "success",
      message: wasPending
        ? `${member.full_name} is now an active member. No email address is on record, so the ID card was not emailed — download it from their record instead.`
        : `No email address is on record for ${member.full_name}, so nothing was sent. Download the card from their record instead.`,
    };
  }

  let png: Buffer;
  try {
    const { data: settings } = await supabase
      .from("site_settings")
      .select("contact_phone, contact_email")
      .limit(1)
      .maybeSingle();

    const assets = await buildIdCardAssets(member.profile_photo_url, {
      phone: settings?.contact_phone ?? null,
      email: settings?.contact_email ?? null,
    });
    png = await renderIdCardPng(toIdCardMember(member), assets);
  } catch (error) {
    console.error("id card render failed:", error);
    return {
      status: "error",
      message: wasPending
        ? `${member.full_name} was approved, but the ID card could not be rendered. Download it from their record and send it manually.`
        : "The ID card could not be rendered. Download it from their record and send it manually.",
    };
  }

  const stateLabel = member.state_code ? stateName(member.state_code) : "";
  const countryLabel = member.country_code ? countryName(member.country_code) : "";
  const where = [member.village, stateLabel, countryLabel].filter(Boolean).join(", ");

  const sent = await sendSmtpMail({
    to: member.email,
    subject: `Your TSSS membership is approved — ID card inside (${member.registration_number})`,
    text: [
      `Dear ${member.full_name},`,
      "",
      "Welcome to Srinivasula Seva Samstha. Your membership has been approved.",
      "",
      `Registration number: ${member.registration_number}`,
      where ? `Recorded address: ${where}` : "",
      "",
      "Your identity card is attached. Please save it and quote your registration",
      "number for programmes, donations and blood assistance.",
      "",
      "Service · Devotion · Unity",
      "Srinivasula Seva Samstha",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    attachments: [{ filename: idCardFileName(toIdCardMember(member)), content: png, contentType: "image/png" }],
  });

  revalidatePath("/admin/registrations");

  if (!sent.ok) {
    return {
      status: "error",
      message: wasPending
        ? `${member.full_name} was approved, but the email could not be sent (${sent.error}). The card can still be downloaded from their record.`
        : `The email could not be sent (${sent.error}). Download the card from their record instead.`,
    };
  }

  return {
    status: "success",
    message: wasPending
      ? `${member.full_name} is now an active member and the ID card was emailed to ${member.email}.`
      : `A fresh ID card was emailed to ${member.email}.`,
  };
}
