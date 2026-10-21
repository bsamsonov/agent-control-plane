/**
 * The two demo tenant policies. They live in @macp/policy (not @macp/db) so that the
 * policy test matrix has no dependency on a database.
 *
 * Rule order matters: the first match wins. Guards are placed before allows on purpose.
 */
import type { PolicyDocument } from './types.js';

const ALWAYS_REDACT = ['recipients', 'customer_emails'];

/**
 * acme — the cautious tenant. Money-spending tools need a human above $100,
 * and everything freezes for approval once 90% of the budget is burned.
 */
export const ACME_POLICY: PolicyDocument = {
  version: 1,
  defaultEffect: 'deny',
  alwaysRedact: ALWAYS_REDACT,
  rules: [
    {
      id: 'budget-guard',
      description: 'Once 90% of the period budget is committed, any ESP action needs a human.',
      when: { tools: ['esp.*'], budgetUtilizationOver: 0.9 },
      effect: 'require_approval',
      reason: 'budget utilization above 90%',
    },
    {
      id: 'viewer-read',
      when: {
        roles: ['viewer'],
        tools: [
          'crm.search_customers',
          'crm.get_segment_stats',
          'analytics.*',
          'esp.get_budget',
          'segment.*',
        ],
      },
      effect: 'allow',
      reason: 'read-only tool for a viewer',
    },
    {
      id: 'viewer-deny-all',
      when: { roles: ['viewer'], tools: ['*'] },
      effect: 'deny',
      reason: 'viewers may not cause side effects',
    },
    {
      id: 'admin-esp',
      when: { roles: ['admin'], tools: ['esp.*'] },
      effect: 'allow',
      requireApprovalOverUsd: 5000,
      amountField: 'amount_usd',
      redact: ['recipients'],
      reason: 'tenant admin acts on behalf of the tenant',
    },
    {
      id: 'marketer-draft',
      description:
        'Creating a campaign object is reversible and spends nothing — no threshold. ' +
        'The money is committed at send time, and that is where the human belongs.',
      when: { roles: ['marketer'], tools: ['esp.create_campaign'] },
      effect: 'allow',
      reason: 'creating a draft campaign has no irreversible effect',
    },
    {
      id: 'marketer-send',
      when: { roles: ['marketer'], tools: ['esp.send_email'] },
      effect: 'allow',
      requireApprovalOverUsd: 100,
      amountField: 'amount_usd',
      redact: ['recipients'],
      reason: 'spending money on behalf of the tenant',
    },
    {
      id: 'read-tools',
      when: {
        roles: ['admin', 'marketer'],
        tools: ['crm.*', 'analytics.*', 'segment.*', 'esp.get_budget'],
      },
      effect: 'allow',
      reason: 'read-only data access',
    },
  ],
};

/**
 * globex — the permissive tenant. Same shape, but the send threshold is effectively
 * unreachable and there is no budget guard. Same brief, different outcome: this is the
 * multi-tenancy proof in the demo.
 */
export const GLOBEX_POLICY: PolicyDocument = {
  version: 1,
  defaultEffect: 'deny',
  alwaysRedact: ALWAYS_REDACT,
  rules: [
    {
      id: 'viewer-read',
      when: {
        roles: ['viewer'],
        tools: [
          'crm.search_customers',
          'crm.get_segment_stats',
          'analytics.*',
          'esp.get_budget',
          'segment.*',
        ],
      },
      effect: 'allow',
      reason: 'read-only tool for a viewer',
    },
    {
      id: 'viewer-deny-all',
      when: { roles: ['viewer'], tools: ['*'] },
      effect: 'deny',
      reason: 'viewers may not cause side effects',
    },
    {
      id: 'admin-esp',
      when: { roles: ['admin'], tools: ['esp.*'] },
      effect: 'allow',
      requireApprovalOverUsd: 100000,
      amountField: 'amount_usd',
      redact: ['recipients'],
      reason: 'tenant admin acts on behalf of the tenant',
    },
    {
      id: 'marketer-draft',
      description:
        'Creating a campaign object is reversible and spends nothing — no threshold. ' +
        'The money is committed at send time, and that is where the human belongs.',
      when: { roles: ['marketer'], tools: ['esp.create_campaign'] },
      effect: 'allow',
      reason: 'creating a draft campaign has no irreversible effect',
    },
    {
      id: 'marketer-send',
      when: { roles: ['marketer'], tools: ['esp.send_email'] },
      effect: 'allow',
      requireApprovalOverUsd: 100000,
      amountField: 'amount_usd',
      redact: ['recipients'],
      reason: 'auto-approved: tenant opted into unattended sending',
    },
    {
      id: 'read-tools',
      when: {
        roles: ['admin', 'marketer'],
        tools: ['crm.*', 'analytics.*', 'segment.*', 'esp.get_budget'],
      },
      effect: 'allow',
      reason: 'read-only data access',
    },
  ],
};
