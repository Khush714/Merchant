import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Savour Partner | Your business, in good hands",
  description: "A thoughtful workspace for food businesses to manage marketplace orders, menus and more.",

};
export default async function RootLayout({ children }: { children: ReactNode }) {
  // The proxy-generated CSP nonce must be applied during a real request render.
  await connection();
  return <html lang="en"><body>{children}</body></html>;
}
