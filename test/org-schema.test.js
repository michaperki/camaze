const { test } = require('node:test');
const assert = require('node:assert/strict');

test('department validation rejects accidental zero coercion and invalid counts', async () => {
  const { departmentSchema } = await import('../shared/org-schema.mjs');
  for (const value of ['', ' ', null, false, -1, 1.5, Infinity]) {
    assert.equal(departmentSchema.safeParse({ name: 'Engineering', headcount: value }).success, false, String(value));
  }
  assert.deepEqual(departmentSchema.parse({ name: ' Engineering ', headcount: '12', monthly_budget_usd: null }), { name: 'Engineering', headcount: 12, monthly_budget_usd: null });
  assert.equal(departmentSchema.partial().safeParse({ monthly_budget_usd: '0' }).success, true);
});

test('people and assignments reject malformed values', async () => {
  const { personSchema, assignmentSchema } = await import('../shared/org-schema.mjs');
  assert.equal(personSchema.safeParse({ name: 'Mike', email: 'broken' }).success, false);
  assert.equal(personSchema.safeParse({ name: 'Mike', email: null, department_id: null }).success, true);
  const assignment = { provider: 'openai', scope: 'project', entity_id: 'project-1', department_id: null, person_id: null };
  assert.equal(assignmentSchema.safeParse(assignment).success, true);
  assert.equal(assignmentSchema.safeParse({ ...assignment, department_id: 42 }).success, false);
});
