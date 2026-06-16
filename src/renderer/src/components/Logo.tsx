// Логотип opdeck — три «карточки» (терминалы стопкой), как в иконке приложения.
// Прозрачный фон, масштабируется до нужного размера.
export default function Logo({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="216 276 600 472"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="236" y="296" width="440" height="300" rx="44" fill="#17171a" stroke="#4a4a55" strokeWidth="22" />
      <rect x="296" y="362" width="440" height="300" rx="44" fill="#17171a" stroke="#7f77dd" strokeWidth="22" />
      <rect x="356" y="428" width="440" height="300" rx="44" fill="#58a6ff" />
    </svg>
  )
}
