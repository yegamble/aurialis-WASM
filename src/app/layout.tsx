import type { Metadata } from "next"
import type { ReactNode } from "react"
import { StoreProvider } from "@/lib/store"
import "@fontsource/instrument-sans/latin-400.css"
import "@fontsource/instrument-sans/latin-500.css"
import "@fontsource/instrument-sans/latin-600.css"
import "@fontsource/newsreader/latin-400.css"
import "@fontsource/newsreader/latin-500.css"
import "@fontsource/newsreader/latin-600.css"
import "./globals.css"

export const metadata: Metadata = {
  title: "Aurialis — Mastering, made human",
  description:
    "Self-contained WebAssembly audio mastering workstation for shaping tone, comparing direction, separating stems, and preparing releases.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  )
}
