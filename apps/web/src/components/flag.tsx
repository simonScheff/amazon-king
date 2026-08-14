import "flag-icons/css/flag-icons.min.css";

const flagCodeAliases: Readonly<Record<string, string>> = {
  // Amazon data can use UK, while flag-icons follows ISO 3166-1 and names it GB.
  uk: "gb",
};

/**
 * Renders a country flag as a bundled SVG background image.
 *
 * Unicode regional-indicator flag emoji (e.g. 🇬🇧) do not render on every
 * platform — Windows shows the bare letters "GB" instead — so flags are drawn
 * from the self-hosted flag-icons sprite instead of relying on emoji fonts.
 */
export function Flag({
  countryCode,
  className = "",
}: {
  countryCode: string;
  className?: string;
}) {
  const normalized = countryCode.toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) return null;
  const flagCode = flagCodeAliases[normalized] ?? normalized;
  return (
    <span
      className={`fi fi-${flagCode} rounded-[2px] ${className}`}
      role="img"
      aria-label={countryCode.toUpperCase()}
    />
  );
}
