// Every setting with its default. Policy can suggest ("defaults") or enforce any of these keys.
export default {
  enabled: true,
  retentionDays: 90,
  idleSeconds: 120,
  excludedDomains: [],
  approvedApps: [],
  unapprovedApps: [],
  licences: [],
  customApps: [],
  unusedAfterDays: 30,
  currency: 'USD',
  reportingEnabled: false,
  reportPeriodDays: 7,
};

export const DESCRIPTIONS = {
  enabled: 'Record time spent in known SaaS apps (domain only).',
  retentionDays: 'Days of daily usage totals to keep in this browser.',
  idleSeconds: 'Stop counting after this many seconds without keyboard or mouse input (minimum 15).',
  excludedDomains: 'Domains that are never recorded, e.g. "linkedin.com".',
  approvedApps: 'App ids marked as approved by IT.',
  unapprovedApps: 'App ids marked as not approved by IT.',
  licences: 'Paid licences: [{ "id", "appId", "seats", "costPerMonth", "owner" }].',
  customApps: 'Extra apps to recognise: [{ "id", "name", "domains": ["example.com"], "category" }].',
  unusedAfterDays: 'A licensed app counts as unused when it was not opened for this many days.',
  currency: 'ISO currency code used to show licence costs.',
  reportingEnabled: 'Allow sending anonymous usage totals to the linked shared-data backend.',
  reportPeriodDays: 'Number of days each report covers. Automatic reports are sent once per period.',
};

// Managed-storage schema for the lists of objects (cannot be inferred from empty defaults).
export const SCHEMA = {
  licences: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' }, appId: { type: 'string' }, seats: { type: 'integer' },
        costPerMonth: { type: 'number' }, owner: { type: 'string' },
      },
    },
  },
  customApps: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' },
        domains: { type: 'array', items: { type: 'string' } }, category: { type: 'string' },
      },
    },
  },
};
