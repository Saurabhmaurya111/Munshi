import type { Metadata } from "next";
import { Manrope, Nunito } from "next/font/google";
import "./globals.css";

const nunito = Nunito({
  subsets: ["latin"],
  variable: "--font-nunito",
  weight: ["700", "800"],
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Munshi — Understands. Plans. Gets it done.",
  description:
    "Not just a bot. An autonomous teammate that understands the case, plans the workflow, and gets it done.",
  icons: {
    icon: "/brand/mark.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${nunito.variable} ${manrope.variable}`}>{children}</body>
    </html>
  );
}
