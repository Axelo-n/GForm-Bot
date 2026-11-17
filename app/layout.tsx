import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GForm Bot",
  description: "Pemindai dan pengisian Google Forms lokal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="id"><body>{children}</body></html>;
}
