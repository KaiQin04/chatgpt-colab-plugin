import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Colab Notebook",
  description: "Run notebooks in ChatGPT using your own Google account and Colab compute credits.",
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
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
