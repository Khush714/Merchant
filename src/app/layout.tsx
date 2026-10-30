import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Savour Partner | Your business, in good hands",
  description: "A thoughtful workspace for food businesses to manage marketplace orders, menus and more.",

};
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
