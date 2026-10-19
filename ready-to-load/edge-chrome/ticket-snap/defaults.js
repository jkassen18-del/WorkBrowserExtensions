// Every Ticket Snap setting with its default. Policy can suggest ("defaults") or enforce any key.
export default {
  // Destination
  destination: 'local', // local | email | webhook | jira | zendesk | freshdesk | servicenow
  helpdeskEmail: '',
  webhookUrl: '',
  webhookToken: '',
  jiraSite: '',
  jiraEmail: '',
  jiraToken: '',
  jiraServiceDeskId: '',
  jiraRequestTypeId: '',
  jiraProjectKey: '',
  jiraIssueType: 'Task',
  zendeskSubdomain: '',
  zendeskEmail: '',
  zendeskToken: '',
  freshdeskDomain: '',
  freshdeskApiKey: '',
  servicenowInstance: '',
  servicenowUser: '',
  servicenowPassword: '',

  // Ticket form
  categories: ['Something is broken', 'Question', 'Access or account', 'Feature request', 'Other'],
  defaultPriority: 'normal', // low | normal | high | urgent
  requiredFields: ['summary'],
  requesterName: '',
  requesterEmail: '',
  rememberRequester: true,

  // Capture
  includeDiagnostics: true,

  // Privacy & storage
  includeUrl: true,
  redactColor: '#000000',
  maxTickets: 50,
  keepScreenshots: true,
  shareScreenshots: false,
};

export const DESCRIPTIONS = {
  destination: 'Where new tickets go: local (My tickets only), email, webhook, jira, zendesk, freshdesk or servicenow. Tickets are always kept in My tickets too.',
  helpdeskEmail: 'Help-desk address for the email destination. Empty uses the brand support email.',
  webhookUrl: 'URL that receives each ticket as JSON (POST), including the screenshot as base64.',
  webhookToken: 'Optional token sent as "Authorization: Bearer <token>" to the webhook.',
  jiraSite: 'Jira site, e.g. https://acme.atlassian.net',
  jiraEmail: 'Atlassian account email used with the API token.',
  jiraToken: 'Atlassian API token.',
  jiraServiceDeskId: 'Jira Service Management service desk id. With a request type id, tickets are created as customer requests.',
  jiraRequestTypeId: 'Jira Service Management request type id.',
  jiraProjectKey: 'Jira project key, used when no service desk id is set (creates a plain issue).',
  jiraIssueType: 'Issue type name for plain Jira issues, e.g. Task or Bug.',
  zendeskSubdomain: 'Zendesk subdomain (acme for acme.zendesk.com).',
  zendeskEmail: 'Zendesk agent email used with the API token.',
  zendeskToken: 'Zendesk API token.',
  freshdeskDomain: 'Freshdesk domain (acme for acme.freshdesk.com).',
  freshdeskApiKey: 'Freshdesk API key.',
  servicenowInstance: 'ServiceNow instance (acme for acme.service-now.com).',
  servicenowUser: 'ServiceNow user name.',
  servicenowPassword: 'ServiceNow password.',
  categories: 'Categories offered in the ticket form.',
  defaultPriority: 'Priority preselected in the ticket form: low, normal, high or urgent.',
  requiredFields: 'Fields that must be filled: summary, description, category, requesterName, requesterEmail.',
  requesterName: 'Requester name prefilled in the ticket form.',
  requesterEmail: 'Requester email prefilled in the ticket form.',
  rememberRequester: 'Remember the name and email typed in the ticket form for next time.',
  includeDiagnostics: 'Attach browser and page diagnostics to new tickets by default.',
  includeUrl: 'Include the page URL (and failed request URLs) in diagnostics.',
  redactColor: 'Fill colour of the redact tool.',
  maxTickets: 'How many tickets to keep in My tickets (oldest are removed first).',
  keepScreenshots: 'Keep the full screenshot with saved tickets. Off keeps only a small thumbnail.',
  shareScreenshots: 'Include screenshots when tickets are sent to the linked shared-data backend.',
};
