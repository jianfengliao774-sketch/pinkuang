import { Ellipsis } from 'lucide-react';

export default function MoreServicesNotice({ label }) {
  return <div className="nav-item muted-nav" style={{ cursor: 'default' }}>
    <Ellipsis size={19} aria-hidden="true" />
    <span>{label}</span>
  </div>;
}
