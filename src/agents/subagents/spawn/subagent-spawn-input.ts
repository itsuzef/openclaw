import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasPromptUnsafeControlCharacter } from "../../sanitize-for-prompt.js";

export function sanitizeMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (hasPromptUnsafeControlCharacter(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._\-/:]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}
