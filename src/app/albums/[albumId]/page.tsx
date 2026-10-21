import { AurialisWorkstation } from "@/components/AurialisWorkstation"

export function generateStaticParams(): { albumId: string }[] {
  return [{ albumId: "placeholder" }]
}

export default async function AlbumDetailPage({
  params,
}: {
  params: Promise<{ albumId: string }>
}) {
  const { albumId } = await params
  return <AurialisWorkstation route="album" paramId={albumId} />
}
