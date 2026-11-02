export default function EchoBrand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`echo-brand${compact ? ' echo-brand--compact' : ''}`} aria-label="Echo Agent">
      <span className="echo-brand__echo">{compact ? 'E' : 'Echo'}</span>
      {!compact && <span className="echo-brand__agent">Agent</span>}
    </span>
  )
}
