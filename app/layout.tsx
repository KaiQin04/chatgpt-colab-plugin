import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Colab Notebook",
  description: "使用自己的 Google 帳號與 Colab 運算額度的私人 Notebook。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}
