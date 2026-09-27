// Validation and saving for the welcome form. No libraries: talks to Supabase's REST API directly.
//
// Security model: the form uses the *publishable* key, which is public by design. Row Level Security on the
// `registrations` table only lets that key INSERT rows with status 'pending' — it can't read, edit or delete
// anything. Leaders review sign-ups in the FCC Attendance Tracker (Members → Sign-ups) before anyone is added.

export type SignUp = {
  fullName: string;
  phone: string;
  email: string;
  invitedBy: string;
  notes: string;
  wantsContact: boolean;
};

export type FieldErrors = Partial<Record<keyof SignUp, string>>;

export type SupabaseConfig = { url: string; key: string };

export const LIMITS = { fullName: 120, phone: 30, email: 120, invitedBy: 120, notes: 1000 } as const;

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

export function tidy(v: SignUp): SignUp {
  return {
    fullName: oneLine(v.fullName, LIMITS.fullName),
    phone: oneLine(v.phone, LIMITS.phone),
    email: oneLine(v.email, LIMITS.email).toLowerCase(),
    invitedBy: oneLine(v.invitedBy, LIMITS.invitedBy),
    notes: v.notes.trim().slice(0, LIMITS.notes),
    wantsContact: v.wantsContact,
  };
}

export function validate(raw: SignUp): FieldErrors {
  const v = tidy(raw);
  const errors: FieldErrors = {};
  if (v.fullName.length < 2) errors.fullName = "Please tell us your name.";
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = "That email doesn't look quite right.";
  if (v.phone) {
    const digits = v.phone.replace(/\D/g, "").length;
    if (!/^[0-9+()\-.\s]+$/.test(v.phone) || digits < 7 || digits > 15) errors.phone = "Please check the phone number.";
  }
  if (v.wantsContact && !v.phone && !v.email && !errors.phone && !errors.email) {
    errors.phone = "Add a phone number or email so we can say hello — or untick the box below.";
  }
  return errors;
}

/** Today's date in New Zealand (YYYY-MM-DD), so a Sunday-morning visit isn't recorded as Saturday (UTC). */
export function nzToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(now);
}

export class SubmitError extends Error {}

export async function submitSignUp(raw: SignUp, cfg: SupabaseConfig): Promise<void> {
  const v = tidy(raw);
  const body = {
    full_name: v.fullName,
    phone: v.phone || null,
    email: v.email || null,
    invited_by: v.invitedBy || null,
    notes: v.notes || null,
    wants_contact: v.wantsContact,
    first_visit: nzToday(),
    status: "pending",
  };
  let res: Response;
  try {
    res = await fetch(`${cfg.url.replace(/\/+$/, "")}/rest/v1/registrations`, {
      method: "POST",
      headers: { apikey: cfg.key, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SubmitError("We couldn't send that — please check your internet connection and try again.");
  }
  if (res.ok) return;
  const detail = await res.text().catch(() => "");
  console.error("Sign-up failed", res.status, detail);
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new SubmitError("The form isn't connected yet. Please let one of the ushers know — sorry about that!");
  }
  throw new SubmitError("Something went wrong on our side. Please try again in a moment.");
}
