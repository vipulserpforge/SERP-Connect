import { apiHandler } from "@/lib/api";
import { getRepository, getSessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export function GET() {
  return apiHandler(async () => {
    const { userId } = await getSessionUser();
    const repo = getRepository();
    const [connections, properties] = await Promise.all([repo.listConnections(userId), repo.listProperties(userId)]);
    // Explicit allowlist of fields: nothing credential-shaped can leak into responses.
    return connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      accountLabel: c.accountLabel,
      status: c.status,
      lastValidatedAt: c.lastValidatedAt,
      properties: properties
        .filter((p) => p.connectionId === c.id)
        .map((p) => ({ id: p.externalPropertyId, name: p.displayName, provider: p.provider, enabled: p.enabledForMcp })),
    }));
  });
}
