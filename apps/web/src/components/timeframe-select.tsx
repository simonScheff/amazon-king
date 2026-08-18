import { Button } from "./ui/button";
import {
  TIMEFRAME_OPTIONS,
  timeframeButtonAriaLabel,
  timeframeButtonLabel,
  type TimeframeOption,
} from "../lib/timeframe";

export function TimeframeSelect({
  value,
  onChange,
}: {
  value: TimeframeOption;
  onChange: (window: TimeframeOption) => void;
}) {
  return (
    <div role="group" aria-label="Date range" className="flex gap-1">
      {TIMEFRAME_OPTIONS.map((option) => (
        <Button
          key={String(option)}
          size="sm"
          variant={option === value ? "primary" : "secondary"}
          aria-label={timeframeButtonAriaLabel(option)}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {timeframeButtonLabel(option)}
        </Button>
      ))}
    </div>
  );
}
