/**
 * @macp/db — public API.
 *
 * Re-exports pools, tenant context helpers, envelope crypto,
 * all repository functions, row types, migrations, seed, and fixtures.
 */
export { getPool, getAdminPool, closePools } from './pool.js';
export { type TenantContext, withTenant, withAdmin } from './tenant.js';
export { sealCredential, openCredential } from './crypto.js';
export { TENANTS, USERS } from './fixtures.js';
export {
  type AuditRow,
  type RunRow,
  type StepRow,
  type ApprovalRow,
  type NewApproval,
  insertAudit,
  listAudit,
  createCampaign,
  setCampaignStatus,
  createRun,
  getRun,
  saveSnapshot,
  listRuns,
  getStepResult,
  putStepResult,
  createApproval,
  listApprovals,
  getApproval,
  decideApproval,
  getPolicy,
  getBudget,
  addSpend,
} from './repos.js';
export { migrate } from './migrate.js';
export { seed } from './seed.js';
