import { z } from "zod";
import { AdapterValidationError } from "./errors.js";

/** Parse an Amazon payload with a zod schema; failures raise a clear AdapterValidationError. */
export function parseWith<S extends z.ZodType>(
  schema: S,
  data: unknown,
  context: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AdapterValidationError(
      context,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
