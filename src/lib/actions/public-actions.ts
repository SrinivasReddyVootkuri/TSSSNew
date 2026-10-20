/**
 * Server actions for public forms.
 *
 * Every action: validates input, checks honeypot + rate limits, calls the
 * database function (which re-validates and enforces uniqueness), then
 * dispatches notifications. Users only ever receive friendly messages.
 */

"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  blogSubmissionSchema,
  bloodHelpSchema,
  donorRegistrationSchema,
  fieldErrors,
  registrationSchema,
  type BlogSubmissionInput,
  type BloodHelpInput,
  type DonorRegistrationInput,
  type RegistrationInput,
} from "@/lib/validation/schemas";
import {
  clientIdentifier,
  isHoneypotTripped,
  rateLimit,
  verifyTurnstile,
} from "@/lib/security/rate-limit";
import { dispatchBloodHelpNotifications } from "@/lib/notifications/dispatch";
import { issueIdCardToken } from "@/lib/idcard/signed-link";
import { uploadObjectKey, verifyImageFile } from "@/lib/security/uploads";
import { slugify, textToSafeHtml } from "@/lib/utils/sanitize";
import type { FormState } from "@/lib/actions/state";

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * No public action may throw: an unexpected failure (a dropped database
 * connection, a stalled upload) must come back as a form message the visitor
 * can retry, never as the application error page.
 */
async function withFriendlyErrors(
  action: string,
  run: () => Promise<FormState>,
): Promise<FormState> {
  try {
    return await run();
  } catch (error) {
    console.error(`${action} failed unexpectedly:`, error);
    return {
      status: "error",
      message:
        "We could not reach our servers. Please check your connection and try again in a moment.",
    };
  }
}

async function registerMemberInner(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isHoneypotTripped(formData)) {
    return { status: "success", message: "Registration received." };
  }

  const headerList = await headers();
  const identifier = clientIdentifier(headerList);

  const limit = rateLimit(`register:${identifier}`, { limit: 8, windowSeconds: 3600 });
  if (!limit.allowed) {
    return {
      status: "error",
      message: "Too many registration attempts. Please try again in a while or contact the administration.",
    };
  }

  const allowed = await verifyTurnstile(
    typeof formData.get("turnstileToken") === "string" ? String(formData.get("turnstileToken")) : null,
    identifier,
  );
  if (!allowed) {
    return { status: "error", message: "Spam verification failed. Please refresh the page and try again." };
  }

  const submission = {
    fullName: String(formData.get("fullName") ?? ""),
    fatherName: String(formData.get("fatherName") ?? ""),
    bloodGroup: String(formData.get("bloodGroup") ?? ""),
    countryCode: String(formData.get("countryCode") ?? ""),
    stateCode: String(formData.get("stateCode") ?? ""),
    districtId: String(formData.get("districtId") ?? ""),
    dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    village: String(formData.get("village") ?? ""),
    mobileNumber: String(formData.get("mobileNumber") ?? ""),
    email: String(formData.get("email") ?? ""),
    age: String(formData.get("age") ?? ""),
  };

  const parsed = registrationSchema.safeParse(submission);

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      errors: fieldErrors(parsed.error),
      // Echoed so the form can keep what the visitor typed.
      values: submission,
    };
  }

  const input: RegistrationInput = parsed.data;

  // The profile photo is optional. A failed upload is reported but never blocks
  // an otherwise valid registration, since the number is issued either way.
  let profilePhotoUrl = "";
  const photo = formData.get("profilePhoto");
  if (photo instanceof File && photo.size > 0) {
    const uploaded = await uploadPublicImage(photo, "profile-photos");
    if (!uploaded.ok) {
      return { status: "error", message: uploaded.error, errors: { profilePhoto: uploaded.error } };
    }
    profilePhotoUrl = uploaded.url;
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("submit_registration_v2", {
    p_full_name: input.fullName,
    // An empty date input must travel as null: PostgREST cannot cast "" to date.
    p_date_of_birth: input.dateOfBirth || null,
    p_father_name: input.fatherName,
    p_gender: "male",
    p_blood_group: input.bloodGroup,
    p_state_code: input.stateCode,
    p_country_code: input.countryCode.toUpperCase(),
    p_village: input.village,
    p_mobile_number: input.mobileNumber,
    p_phone_country_code: null,
    p_profile_photo_url: profilePhotoUrl || null,
    p_email: input.email || null,
    p_age: Number(input.age),
    p_district_id: input.districtId || null,
    p_rate_key: identifier,
  });

  if (error) {
    const code = error.message ?? "";
    if (code.includes("already_registered")) {
      return {
        status: "error",
        message:
          "You are already registered. If you believe this is an issue, please contact the administration.",
      };
    }
    if (code.includes("RATE_LIMITED")) {
      return {
        status: "error",
        message: "Too many attempts from this device. Please try again later.",
      };
    }
    if (
      code.includes("INVALID_MOBILE") ||
      code.includes("INVALID_DOB") ||
      code.includes("INVALID_NAME") ||
      code.includes("INVALID_VILLAGE") ||
      code.includes("INVALID_FATHER_NAME") ||
      code.includes("INVALID_BLOOD_GROUP") ||
      code.includes("INVALID_GENDER") ||
      code.includes("INVALID_COUNTRY") ||
      code.includes("INVALID_STATE") ||
      code.includes("INVALID_AGE") ||
      code.includes("INVALID_DISTRICT")
    ) {
      return { status: "error", message: "Please check your details and try again." };
    }
    console.error("submit_registration_v2 failed:", error.message);
    return {
      status: "error",
      message: "We could not complete your registration right now. Please try again in a moment.",
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const resultCode = row?.result_code as string | undefined;

  if (resultCode === "already_registered") {
    return {
      status: "error",
      message:
        "You are already registered. If you believe this is an issue, please contact the administration.",
    };
  }

  revalidatePath("/admin/registrations");

  const registrationNumber = String(row?.registration_number ?? "");

  // A signed link so the new member can download their own ID card. It carries
  // no authority beyond this one card, for one hour.
  let idCardToken = "";
  if (registrationNumber) {
    try {
      idCardToken = issueIdCardToken(registrationNumber, input.mobileNumber).token;
    } catch (error) {
      // A missing signing key must not cost the member their registration.
      console.error("id card link could not be signed:", error);
    }
  }

  return {
    status: "success",
    message: "Registration successful.",
    data: {
      registrationNumber,
      fullName: row?.full_name ?? input.fullName,
      dateOfBirth: row?.date_of_birth ?? input.dateOfBirth,
      village: row?.village ?? input.village,
      registeredAt: row?.registered_at ?? new Date().toISOString(),
      mobileNumber: input.mobileNumber,
      idCardToken,
    },
  };
}

export async function registerMember(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return withFriendlyErrors("registerMember", () => registerMemberInner(_previous, formData));
}

/* -------------------------------------------------------------------------- */
/* Blood donations                                                          */
/* -------------------------------------------------------------------------- */

export async function submitBloodHelpRequest(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return withFriendlyErrors("submitBloodHelpRequest", () =>
    submitBloodHelpRequestInner(_previous, formData),
  );
}

async function submitBloodHelpRequestInner(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isHoneypotTripped(formData)) {
    return { status: "success", message: "Request received." };
  }

  const headerList = await headers();
  const identifier = clientIdentifier(headerList);

  const limit = rateLimit(`blood:${identifier}`, { limit: 5, windowSeconds: 3600 });
  if (!limit.allowed) {
    return {
      status: "error",
      message:
        "Too many blood donation requests from this device. Please call the helpline if this is urgent.",
    };
  }

  const allowed = await verifyTurnstile(
    typeof formData.get("turnstileToken") === "string" ? String(formData.get("turnstileToken")) : null,
    identifier,
  );
  if (!allowed) {
    return { status: "error", message: "Spam verification failed. Please refresh the page and try again." };
  }

  const submission = {
    requesterName: String(formData.get("requesterName") ?? ""),
    mobileNumber: String(formData.get("mobileNumber") ?? ""),
    bloodGroup: String(formData.get("bloodGroup") ?? ""),
    hospitalName: String(formData.get("hospitalName") ?? ""),
    hospitalLocation: String(formData.get("hospitalLocation") ?? ""),
    districtId: String(formData.get("districtId") ?? ""),
    areaId: String(formData.get("areaId") ?? ""),
    requiredDate: String(formData.get("requiredDate") ?? ""),
    unitsRequired: String(formData.get("unitsRequired") ?? ""),
    message: String(formData.get("message") ?? ""),
  };

  const parsed = bloodHelpSchema.safeParse(submission);

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      errors: fieldErrors(parsed.error),
      values: submission,
    };
  }

  const input: BloodHelpInput = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("create_blood_request", {
    p_requester_name: input.requesterName,
    p_mobile_number: input.mobileNumber,
    p_blood_group: input.bloodGroup,
    p_hospital_name: input.hospitalName,
    p_hospital_location: input.hospitalLocation || null,
    p_district_id: input.districtId,
    p_area_id: input.areaId || null,
    p_required_date: input.requiredDate || null,
    p_units_required: input.unitsRequired,
    p_message: input.message || null,
    p_rate_key: identifier,
  });

  if (error) {
    const code = error.message ?? "";
    if (code.includes("RATE_LIMITED")) {
      return { status: "error", message: "Too many requests from this device. Please try again later." };
    }
    if (code.startsWith("INVALID_")) {
      return { status: "error", message: "Please check your details and try again." };
    }
    console.error("create_blood_request failed:", error.message);
    return {
      status: "error",
      message: "We could not submit your request right now. Please try again or call the helpline.",
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const requestId = row?.request_id as string | undefined;
  const isUnassigned = Boolean(row?.is_unassigned);

  if (requestId) {
    const outcome = await dispatchBloodHelpNotifications({
      requestId,
      requestNumber: String(row?.request_number ?? ""),
      isUnassigned,
      assignedAdminEmail: (row?.assigned_admin_email as string | null) ?? null,
      assignedAdminWhatsapp: (row?.assigned_admin_whatsapp as string | null) ?? null,
      requesterName: String(row?.requester_name ?? ""),
      mobileNumber: String(row?.mobile_number ?? ""),
      bloodGroup: String(row?.blood_group ?? ""),
      hospitalName: String(row?.hospital_name ?? ""),
      hospitalLocation: (row?.hospital_location as string | null) ?? "",
      requiredDate: (row?.required_date as string | null) ?? null,
      unitsRequired: Number(row?.units_required ?? 1),
      message: (row?.message as string | null) ?? "",
      districtName: String(formData.get("districtName") ?? ""),
      areaName: String(formData.get("areaName") ?? ""),
    });

    revalidatePath("/admin/blood-help/requests");
    if (!outcome.delivered) {
      return {
        status: "success",
        message:
          "Your request was saved, but our volunteers could not be notified automatically. Please call the blood helpline so we can act quickly.",
        data: {
          requestNumber: String(row?.request_number ?? ""),
          unassigned: true,
        },
      };
    }
  }

  return {
    status: "success",
    message: isUnassigned
      ? "Your request has been recorded. Our central team has been informed and will contact you shortly."
      : "Your request has been recorded and the district volunteer has been notified.",
    data: {
      requestNumber: String(row?.request_number ?? ""),
      unassigned: isUnassigned,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Blood donor registration                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Registers somebody as willing to donate blood.
 *
 * Unlike the emergency blood donations form, this creates no notifications and no
 * routing. It records intent, so the dashboard and the administrators know who
 * to call when a matching request arrives.
 */
export async function registerDonor(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return withFriendlyErrors("registerDonor", () => registerDonorInner(_previous, formData));
}

async function registerDonorInner(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isHoneypotTripped(formData)) {
    return { status: "success", message: "Thank you for your willingness to donate." };
  }

  const headerList = await headers();
  const identifier = clientIdentifier(headerList);

  const limit = rateLimit(`donor:${identifier}`, { limit: 5, windowSeconds: 86400 });
  if (!limit.allowed) {
    return {
      status: "error",
      message: "You have already registered as a donor recently. Please try again tomorrow.",
    };
  }

  const allowed = await verifyTurnstile(
    typeof formData.get("turnstileToken") === "string" ? String(formData.get("turnstileToken")) : null,
    identifier,
  );
  if (!allowed) {
    return { status: "error", message: "Spam verification failed. Please refresh the page and try again." };
  }

  const submission = {
    fullName: String(formData.get("fullName") ?? ""),
    fatherName: String(formData.get("fatherName") ?? ""),
    mobileNumber: String(formData.get("mobileNumber") ?? ""),
    email: String(formData.get("email") ?? ""),
    bloodGroup: String(formData.get("bloodGroup") ?? ""),
    dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    gender: String(formData.get("gender") ?? ""),
    countryCode: String(formData.get("countryCode") ?? ""),
    stateCode: String(formData.get("stateCode") ?? ""),
    city: String(formData.get("city") ?? ""),
    area: String(formData.get("area") ?? ""),
    address: String(formData.get("address") ?? ""),
    lastDonationDate: String(formData.get("lastDonationDate") ?? ""),
    availability: String(formData.get("availability") ?? ""),
    preferredContact: String(formData.get("preferredContact") ?? "phone"),
  };

  const parsed = donorRegistrationSchema.safeParse(submission);

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      errors: fieldErrors(parsed.error),
      values: submission,
    };
  }

  const input: DonorRegistrationInput = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("submit_donor", {
    p_full_name: input.fullName,
    p_father_name: input.fatherName || null,
    p_mobile_number: input.mobileNumber,
    p_phone_country_code: null,
    p_email: input.email || null,
    p_blood_group: input.bloodGroup,
    p_date_of_birth: input.dateOfBirth || null,
    p_gender: input.gender || null,
    p_country_code: input.countryCode.toUpperCase(),
    p_state_code: input.stateCode || null,
    p_city: input.city || null,
    p_area: input.area || null,
    p_address: input.address || null,
    p_last_donation_date: input.lastDonationDate || null,
    p_availability: input.availability || null,
    p_preferred_contact: input.preferredContact || "phone",
    p_member_id: null,
    p_rate_key: identifier,
  });

  if (error) {
    const code = error.message ?? "";
    if (code.includes("RATE_LIMITED")) {
      return {
        status: "error",
        message: "You have already registered as a donor recently. Please try again tomorrow.",
      };
    }
    if (
      code.includes("INVALID_MOBILE") ||
      code.includes("INVALID_NAME") ||
      code.includes("INVALID_FATHER_NAME") ||
      code.includes("INVALID_BLOOD_GROUP") ||
      code.includes("INVALID_GENDER") ||
      code.includes("INVALID_COUNTRY") ||
      code.includes("INVALID_CONTACT_PREFERENCE") ||
      code.includes("INVALID_LAST_DONATION")
    ) {
      return { status: "error", message: "Please check your details and try again." };
    }
    console.error("submit_donor failed:", error.message);
    return {
      status: "error",
      message: "We could not record your willingness right now. Please try again in a moment.",
    };
  }

  const row = Array.isArray(data) ? data[0] : data;

  revalidatePath("/admin/blood-donation/donors");

  return {
    status: "success",
    message:
      row?.result_code === "updated"
        ? "Thank you. Your donor record has been updated."
        : "Thank you for stepping forward. You are now on the donor roll, and we will call you when your blood group is needed.",
  };
}

/* -------------------------------------------------------------------------- */
/* Public blog submission                                                     */
/* -------------------------------------------------------------------------- */

export async function submitBlogPost(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return withFriendlyErrors("submitBlogPost", () => submitBlogPostInner(_previous, formData));
}

async function submitBlogPostInner(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isHoneypotTripped(formData)) {
    return { status: "success", message: "Thank you. Your article has been submitted for review." };
  }

  const headerList = await headers();
  const identifier = clientIdentifier(headerList);

  const limit = rateLimit(`blog:${identifier}`, { limit: 3, windowSeconds: 86_400 });
  if (!limit.allowed) {
    return {
      status: "error",
      message: "You have already submitted articles recently. Please try again tomorrow.",
    };
  }

  const allowed = await verifyTurnstile(
    typeof formData.get("turnstileToken") === "string" ? String(formData.get("turnstileToken")) : null,
    identifier,
  );
  if (!allowed) {
    return { status: "error", message: "Spam verification failed. Please refresh the page and try again." };
  }

  let imageUrl = "";
  const upload = formData.get("featuredImage");
  if (upload instanceof File && upload.size > 0) {
    const uploaded = await uploadPublicImage(upload, "blogs");
    if (!uploaded.ok) {
      return { status: "error", message: uploaded.error };
    }
    imageUrl = uploaded.url;
  } else if (typeof upload === "string" && upload.trim()) {
    imageUrl = upload.trim();
  }

  const submission = {
    authorName: String(formData.get("authorName") ?? ""),
    authorEmail: String(formData.get("authorEmail") ?? ""),
    authorMobile: String(formData.get("authorMobile") ?? ""),
    title: String(formData.get("title") ?? ""),
    category: String(formData.get("category") ?? ""),
    content: String(formData.get("content") ?? ""),
    featuredImage: imageUrl,
  };

  const parsed = blogSubmissionSchema.safeParse(submission);

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      errors: fieldErrors(parsed.error),
      values: submission,
    };
  }

  const input: BlogSubmissionInput = parsed.data;
  const supabase = await createClient();

  const { error } = await supabase.rpc("submit_blog", {
    p_author_name: input.authorName,
    p_author_email: input.authorEmail,
    p_author_mobile: input.authorMobile || null,
    p_title: input.title,
    p_content: textToSafeHtml(input.content),
    p_category: input.category,
    p_featured_image: input.featuredImage || null,
    p_rate_key: identifier,
  });

  if (error) {
    if (error.message.includes("RATE_LIMITED")) {
      return { status: "error", message: "You have already submitted articles recently. Please try again later." };
    }
    console.error("submit_blog failed:", error.message);
    return {
      status: "error",
      message: "We could not submit your article right now. Please try again in a moment.",
    };
  }

  revalidatePath("/admin/blogs");

  return {
    status: "success",
    message: "Thank you. Your article has been submitted and is awaiting administrator approval.",
    data: { slug: slugify(input.title) },
  };
}

/* -------------------------------------------------------------------------- */
/* Shared image upload                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Uploads an image to the public Supabase Storage bucket.
 *
 * The bytes are decoded with sharp before anything is stored, so a script
 * renamed to .png is rejected no matter what MIME type it claims. The verified
 * buffer — not the original file — is what gets uploaded.
 */
export async function uploadPublicImage(
  file: File,
  folder = "uploads",
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const verified = await verifyImageFile(file);
  if (!verified.ok) return verified;

  const path = uploadObjectKey(folder, verified.extension);

  const supabase = await createClient();
  const { error } = await supabase.storage.from("public-media").upload(path, verified.buffer, {
    contentType: file.type,
    upsert: false,
  });

  if (error) {
    console.error("storage upload failed:", error.message);
    return { ok: false, error: "We could not upload that image. Please try a different file." };
  }

  const { data } = supabase.storage.from("public-media").getPublicUrl(path);
  return { ok: true, url: data.publicUrl };
}
