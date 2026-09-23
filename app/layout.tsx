import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/auth-context";
import { SelectedProjectProvider } from "@/contexts/selected-project-context";
import { BRAND } from "@/lib/brand";

const inter = Inter({ subsets: ["latin"], display: "swap" });

// Icons come from the Next.js file conventions: app/favicon.ico,
// app/icon.png and app/apple-icon.png (Test Manager brand pack).
export const metadata: Metadata = {
  title: { default: BRAND.productName, template: `%s | ${BRAND.productName}` },
  description: BRAND.productDescription,
  applicationName: BRAND.productName,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <AuthProvider>
          <SelectedProjectProvider>{children}</SelectedProjectProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
