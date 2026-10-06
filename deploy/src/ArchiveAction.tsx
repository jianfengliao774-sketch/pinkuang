import { FileClock } from 'lucide-react';
import type { DeploymentSnapshot } from './deployment';

export function ArchiveCompletedAction({ snapshot, busy, journalReady, onBsc, onArchive }: {
  snapshot: DeploymentSnapshot | null; busy: boolean; journalReady: boolean;
  onBsc: boolean; onArchive: () => void;
}) {
  if (!snapshot || snapshot.status !== 'complete'
    || snapshot.steps.some(step => step.id === 'FreshPoolFactory')) return null;
  return <button className="text-button" disabled={busy || !journalReady || !onBsc} onClick={onArchive}>
    <FileClock size={14}/>归档本次部署并新建</button>;
}
