import { z } from 'zod';

// Accept numeric form strings, but never interpret blank/null/boolean as zero.
const number = z.union([z.number(), z.string().trim().min(1)]).pipe(z.coerce.number().finite().nonnegative());
const name = z.string().trim().min(1, 'Name is required');
const optionalId = z.string().trim().min(1).nullable().optional();
export const departmentSchema = z.object({
  name,
  headcount: number.pipe(z.number().int()).optional(),
  monthly_budget_usd: number.nullable().optional(),
});
export const personSchema = z.object({
  name,
  email: z.union([z.email(), z.literal('')]).nullable().optional(),
  department_id: optionalId,
});
export const assignmentSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'google']),
  scope: z.enum(['api_key', 'workspace', 'project']),
  entity_id: z.string().min(1),
  department_id: optionalId,
  person_id: optionalId,
});
export function validationError(schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return `${issue.path.join('.') || 'Request'}: ${issue.message}`;
}
