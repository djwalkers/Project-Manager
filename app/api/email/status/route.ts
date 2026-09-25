import { NextResponse } from "next/server";
import { requireAdminOrManagerUser } from "@/lib/api-auth";
import { getEmailDeliveryHealth } from "@/lib/email-delivery";

// Email delivery health (System Health page — Manager/Admin). It includes
// recent email activity (recipients, failure reasons) read with the
// service-role key, so it must never be served to anonymous callers.
export async function GET() {
  const authError = await requireAdminOrManagerUser();
  if (authError) return authError;
  return NextResponse.json(await getEmailDeliveryHealth());
}
