import { useStore } from '../store'

export default function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div className="toast-main">
            {t.title && <div className="toast-title">{t.title}</div>}
            <div className="toast-body">{t.text}</div>
          </div>
          <button className="toast-x" title="Закрыть" onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
