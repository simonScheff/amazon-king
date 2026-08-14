import "flag-icons/css/flag-icons.min.css";

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
  return (
    <span
      className={`fi fi-${normalized} rounded-[2px] ${className}`}
      role="img"
      aria-label={countryCode.toUpperCase()}
    />
  );
}
