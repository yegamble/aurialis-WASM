import { AurialisWorkstation } from "@/components/AurialisWorkstation"

export function generateStaticParams(): { trackId: string }[] {
  return [
    { trackId: "placeholder" },
  ]
}

export default async function ReferenceTrackPage({
  params,
}: {
  params: Promise<{ trackId: string }>
}) {
  const { trackId } = await params
  return <AurialisWorkstation route="reference" paramId={trackId} />
}
