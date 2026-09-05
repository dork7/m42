export function AmbientBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
      <div
        className="blob blob-1 absolute -left-20 -top-20 h-72 w-72 rounded-full opacity-35 blur-[100px]"
        style={{ background: 'var(--berry)' }}
      />
      <div
        className="blob blob-2 absolute -right-16 top-1/4 h-80 w-80 rounded-full opacity-30 blur-[110px]"
        style={{ background: 'var(--aloe)' }}
      />
      <div
        className="blob blob-3 absolute bottom-1/4 left-1/4 h-64 w-64 rounded-full opacity-40 blur-[90px]"
        style={{ background: 'var(--lilac)' }}
      />
      <div
        className="blob blob-4 absolute -bottom-16 right-1/4 h-72 w-72 rounded-full opacity-25 blur-[120px]"
        style={{ background: 'var(--peach)' }}
      />
    </div>
  )
}
