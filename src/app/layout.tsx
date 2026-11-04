import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Risen Team Schedule Builder v1.0",
  description:
    "Локальний конструктор тижневого розкладу тренувань: редагування, версії, перегляд та експорт у PNG/PDF.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/logo-sign.svg" },
};

export const viewport: Viewport = {
  themeColor: "#0a0b0f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uk">
      <body className="bg-[#08090d] text-slate-200 antialiased">{children}</body>
    </html>
  );
}
