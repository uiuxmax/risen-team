import type { ReactNode } from "react";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { WorkspaceProvider } from "@/components/app/WorkspaceProvider";
import { AppShell } from "@/components/app/AppShell";
import { ensureSeeded } from "@/lib/server/seed";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  try {
    await ensureSeeded();
  } catch {
    // The workspace loader surfaces a friendly error if the database is unavailable.
  }

  return (
    <LanguageProvider>
      <WorkspaceProvider>
        <AppShell>{children}</AppShell>
      </WorkspaceProvider>
    </LanguageProvider>
  );
}
