# Aurialis logo assets

The horizontal logo combines the circular three-bar listening mark with the **Aurialis** wordmark from the supplied reference.

| Asset | Use |
| --- | --- |
| [Ink logo](aurialis-logo.svg) | Light backgrounds; `#29231f` artwork. |
| [Paper logo](aurialis-logo-dark.svg) | Dark backgrounds; `#faf7f0` artwork. |

Both SVGs have transparent backgrounds and the same `500 × 140` view box. All lettering is outlined, so they need no installed fonts, external images or JavaScript. Scale them proportionally and keep the mark and name together.

The wordmark uses Newsreader SemiBold at weight 600, the display family already used by the application. Its glyph outlines come from the installed `@fontsource/newsreader` package. [The Newsreader project](https://github.com/productiontype/Newsreader) licenses its font under the SIL Open Font License 1.1; these assets are rendered artwork, not redistributed font files.

The root README uses a centered `<picture>` with the paper version for dark mode and the ink version as its light-mode fallback, following the header pattern in [Next.js](https://github.com/vercel/next.js) and [Auth.js](https://github.com/nextauthjs/next-auth). Its badge row links to the live main-branch CI status and the checked-in stack versions. Update version badges when their repository pins change.
