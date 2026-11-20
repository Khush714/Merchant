import MerchantApp from "@/components/merchant-app";
import { getWorkspaceBootstrap } from "@/lib/workspace-bootstrap";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Resolve auth and the first screen's data on the server so the first paint is
  // real workspace data, not sample data that is later wiped and reloaded.
  const bootstrap = await getWorkspaceBootstrap();
  return <MerchantApp initialAuth={bootstrap.auth} initialWorkspace={bootstrap.workspace} />;
}
