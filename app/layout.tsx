import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/auth-context";
import { SelectedProjectProvider } from "@/contexts/selected-project-context";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Project Manager",
  description: "Multi-project delivery control centre",
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
