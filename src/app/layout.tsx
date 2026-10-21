import type { Metadata } from "next"
import type { ReactNode } from "react"
import { StoreProvider } from "@/lib/store"
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
