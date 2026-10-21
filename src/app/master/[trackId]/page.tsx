import { AurialisWorkstation } from "@/components/AurialisWorkstation"

export function generateStaticParams(): { trackId: string }[] {
  return [
    { trackId: "demo-1" },
    { trackId: "demo-2" },
    { trackId: "demo-3" },
    { trackId: "placeholder" },
  ]
}

export default async function MasterTrackPage({
  params,
}: {
  params: Promise<{ trackId: string }>
}) {
  const { trackId } = await params
  return <AurialisWorkstation route="master" paramId={trackId} />
}
