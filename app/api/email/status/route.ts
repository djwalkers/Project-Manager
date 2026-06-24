import { NextResponse } from "next/server";
import { getEmailDeliveryHealth } from "@/lib/email-delivery";

export async function GET() {
  return NextResponse.json(await getEmailDeliveryHealth());
}
