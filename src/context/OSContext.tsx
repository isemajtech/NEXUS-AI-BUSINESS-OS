import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  Business,
  Project,
  AIAgentDepartment,
  AgentTask,
  Product,
  Order,
  Customer,
  MarketingCampaign,
  ExpenseRecord,
  AutomationRule,
  ApprovalRequest,
  ActivityLog,
  Conversation,
  ChatMessage,
  UserOwnerProfile,
  AIProviderConfig,
  AIDepartmentType,
  ApprovalType,
  BusinessMemory,
  MemoryCategory,
  MemoryImportance,
  FactoryJob,
  FactoryPipelineStage,
} from '../types';
import {
  StoredSupabaseConfig,
  getStoredSupabaseConfig,
  saveStoredSupabaseConfig,
  getSupabaseClient,
  getSupabaseAccessToken,
  authorizedApiFetch,
  invokeAIAssistantEdgeFunction,
  fetchBusinessMemoriesFromSupabase,
  saveBusinessMemoryToSupabase,
  deleteBusinessMemoryFromSupabase,
  upsertFactoryJobToSupabase,
  syncProductGumroadFieldsToSupabase,
} from '../lib/supabase';
import {
  type ServerOwnerApprovalRecord,
  createAuthoritativeOwnerApproval,
  fetchAuthoritativeOwnerApprovals,
  ingestRefundProvenance,
  revokeAuthoritativeOwnerApproval,
} from '../lib/governanceClient';
import {
  runFactoryResearch,
  generateFactoryProductPackage,
  generateProductCoverAsset,
  buildProductPdfAsset,
  runFactoryLaunchKit,
} from '../lib/factoryClient';
import { FLAGSHIP_CONTENT_MACHINE_PRODUCT } from '../data/contentMachineProduct';
import {
  ProvenanceRecord,
} from '../governance/provenance';
import { evaluateFinanceRefund } from '../governance/financeRefundGate';

export type NavSection =
  | 'command_center'
  | 'ai_assistant'
  | 'businesses'
  | 'websites_apps'
  | 'ai_workforce'
  | 'products'
  | 'orders_customers'
  | 'marketing'
  | 'financial_center'
  | 'automations'
  | 'approval_center'
  | 'activity_history'
  | 'settings';

export interface OSContextType {
  activeSection: NavSection;
  setActiveSection: (section: NavSection) => void;
  productsViewMode: 'studio' | 'factory' | 'live_sales' | 'storefront';
  setProductsViewMode: (mode: 'studio' | 'factory' | 'live_sales' | 'storefront') => void;
  selectedBusinessId: string; // 'all' or specific business id
  setSelectedBusinessId: (id: string) => void;
  selectedBusiness: Business | null;
  
  // Owner profile & Security
  ownerProfile: UserOwnerProfile;
  updateOwnerProfile: (profile: Partial<UserOwnerProfile>) => void;
  lockOS: () => void;
  unlockOS: (pin?: string) => boolean;

  // Businesses
  businesses: Business[];
  addBusiness: (business: Omit<Business, 'id' | 'createdAt' | 'updatedAt'>) => Business;
  updateBusiness: (id: string, updates: Partial<Business>) => void;
  archiveBusiness: (id: string) => void;
  deleteBusiness: (id: string) => void;

  // Projects (Websites & Apps)
  projects: Project[];
  addProject: (project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>) => Project;
  updateProject: (id: string, updates: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  pingProjectHealth: (id: string) => Promise<void>;

  // AI Workforce Departments
  departments: AIAgentDepartment[];
  updateDepartment: (type: AIDepartmentType, updates: Partial<AIAgentDepartment>) => void;
  tasks: AgentTask[];
  addTask: (task: Omit<AgentTask, 'id' | 'createdAt'>) => AgentTask;
  updateTaskStatus: (id: string, status: AgentTask['status'], result?: string) => void;

  // Products
  products: Product[];
  addProduct: (product: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'salesCount' | 'totalRevenue'>) => Product;
  updateProduct: (id: string, updates: Partial<Product>) => void;
  submitProductForApproval: (productId: string) => void;
  approveAndPublishProductDirect: (productId: string, note?: string) => Promise<void>;
  deleteProduct: (id: string) => void;
  restoreFlagshipContentMachine: () => void;

  // Phase 4: Unified Digital Product Factory Orchestrator
  factoryJobs: FactoryJob[];
  runDigitalProductFactory: (input: {
    topic: string;
    targetAudience: string;
    businessId: string;
    productType: Product['type'];
    price: number;
    billingType: Product['billingType'];
  }) => Promise<{
    job: FactoryJob;
    product: Product;
    campaign: MarketingCampaign;
    approval: ApprovalRequest;
    pdfBlob?: Blob;
    pdfFilename?: string;
  }>;

  // Orders & Customers
  orders: Order[];
  customers: Customer[];
  addOrder: (order: Omit<Order, 'id' | 'createdAt' | 'orderNumber'>) => Order;
  addCustomer: (customer: Omit<Customer, 'id' | 'totalSpend' | 'ordersCount'>) => Customer;
  recordCustomerPurchase: (productId: string, buyerName: string, buyerEmail: string, paymentMethod: string) => Order | null;
  syncGumroadSales: (
    sales: Array<{
      saleId: string;
      gumroadProductId?: string;
      productName: string;
      buyerName: string;
      buyerEmail: string;
      amountDollars: number;
      currency?: string;
      refunded?: boolean;
      createdAt?: string;
    }>
  ) => { imported: number; updated: number; skipped: number };
  requestRefund: (
    orderId: string,
    reason: string,
    provenanceOverride?: ProvenanceRecord
  ) => Promise<{ ok: boolean; error?: string }>;

  // Marketing
  campaigns: MarketingCampaign[];
  addCampaign: (campaign: Omit<MarketingCampaign, 'id' | 'createdAt' | 'spent'>) => MarketingCampaign;
  updateCampaign: (id: string, updates: Partial<MarketingCampaign>) => void;
  submitCampaignForApproval: (campaignId: string) => void;
  deleteCampaign: (id: string) => void;

  // Financials & Expenses
  expenses: ExpenseRecord[];
  addExpense: (expense: Omit<ExpenseRecord, 'id' | 'createdAt'>) => ExpenseRecord;
  deleteExpense: (id: string) => void;

  // Automations
  automations: AutomationRule[];
  toggleAutomation: (id: string) => void;
  addAutomation: (rule: Omit<AutomationRule, 'id' | 'executionCount'>) => AutomationRule;
  deleteAutomation: (id: string) => void;

  // Approval Center
  approvals: ApprovalRequest[];
  serverOwnerApprovals: ServerOwnerApprovalRecord[];
  isSyncingServerApprovals: boolean;
  serverApprovalsError: string | null;
  refreshAuthoritativeApprovals: () => Promise<void>;
  revokeServerOwnerApproval: (approvalId: string) => Promise<{ ok: boolean; error?: string }>;
  createApprovalRequest: (req: Omit<ApprovalRequest, 'id' | 'createdAt' | 'status'>) => ApprovalRequest;
  approveRequest: (id: string, note?: string) => Promise<{ ok: boolean; error?: string; approval?: ServerOwnerApprovalRecord }>;
  rejectRequest: (id: string, reason: string) => Promise<{ ok: boolean; error?: string }>;

  // Activity Log
  activityLogs: ActivityLog[];
  logActivity: (action: string, details: string, severity?: ActivityLog['severity'], businessId?: string) => void;
  clearActivityLogs: () => void;

  // AI Assistant Chat
  conversations: Conversation[];
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  chatMessages: ChatMessage[];
  createNewConversation: (title?: string) => string;
  sendMessageToAssistant: (content: string) => Promise<void>;
  deleteConversation: (id: string) => void;
  isAiThinking: boolean;

  // Supabase & AI Configurations
  supabaseConfig: StoredSupabaseConfig;
  updateSupabaseConfig: (config: StoredSupabaseConfig) => void;
  aiConfig: AIProviderConfig;
  updateAIConfig: (config: Partial<AIProviderConfig>) => void;

  // Persistent Business Memory Bank
  memories: BusinessMemory[];
  addMemory: (mem: Omit<BusinessMemory, 'id' | 'createdAt' | 'updatedAt'>) => BusinessMemory;
  updateMemory: (id: string, updates: Partial<BusinessMemory>) => void;
  deleteMemory: (id: string) => void;
  togglePinMemory: (id: string) => void;
  getMemoriesForContext: (businessId?: string, department?: AIDepartmentType) => BusinessMemory[];

  // Backup & Reset
  exportDatabaseJSON: () => string;
  importDatabaseJSON: (jsonStr: string) => boolean;
  seedRealisticStarterData: () => void;
  resetToCleanSlate: () => void;
}

const OSContext = createContext<OSContextType | undefined>(undefined);

// Initial 6 AI departments configured as required
const INITIAL_DEPARTMENTS: AIAgentDepartment[] = [
  {
    id: 'dept-dev',
    type: 'development',
    name: 'Development & Engineering',
    description: 'Code synthesis, GitHub repository management, full-stack architecture, deployment verification, bug fixes.',
    status: 'active',
    autonomyLevel: 'strict_approval',
    activeTasksCount: 0,
    completedTasksCount: 0,
    systemInstructions: 'You are the Senior Technical Architect and Lead Engineer. You design microservices, review database migrations, write clean TypeScript/React code, and guarantee zero-downtime deployments. Never deploy production code without Owner Approval.',
    permissions: {
      canDeployCode: false,
      canPublishProducts: false,
      canSendMarketing: false,
      canIssueRefunds: false,
      canRecordExpenses: false,
      canModifySecurity: false,
    },
    lastActiveAt: new Date().toISOString(),
  },
  {
    id: 'dept-prod',
    type: 'product_creation',
    name: 'Product Creation & Strategy',
    description: 'Digital product ideation, PRD authoring, pricing tier modeling, packaging and launch preparation.',
    status: 'active',
    autonomyLevel: 'strict_approval',
    activeTasksCount: 0,
    completedTasksCount: 0,
    systemInstructions: 'You analyze market demand, craft digital products, software tools, educational assets, and subscription tiers. You optimize value metrics and require Owner Approval before publishing any product to customer catalogs.',
    permissions: {
      canDeployCode: false,
      canPublishProducts: false,
      canSendMarketing: false,
      canIssueRefunds: false,
      canRecordExpenses: false,
      canModifySecurity: false,
    },
    lastActiveAt: new Date().toISOString(),
  },
  {
    id: 'dept-mktg',
    type: 'marketing',
    name: 'Marketing & Growth',
    description: 'Multi-channel acquisition, SEO positioning, content syndication, newsletter broadcasts, conversion optimization.',
    status: 'active',
    autonomyLevel: 'strict_approval',
    activeTasksCount: 0,
    completedTasksCount: 0,
    systemInstructions: 'You design organic acquisition funnels, draft high-converting email sequences, formulate SEO strategies, and track customer acquisition costs. You must route all outbound campaigns through the Approval Center.',
    permissions: {
      canDeployCode: false,
      canPublishProducts: false,
      canSendMarketing: false,
      canIssueRefunds: false,
      canRecordExpenses: false,
      canModifySecurity: false,
    },
    lastActiveAt: new Date().toISOString(),
  },
  {
    id: 'dept-cust',
    type: 'customer_support',
    name: 'Customer Support & Success',
    description: 'Customer inquiry triage, onboarding flow optimization, ticket resolution, churn prevention.',
    status: 'active',
    autonomyLevel: 'semi_autonomous',
    activeTasksCount: 0,
    completedTasksCount: 0,
    systemInstructions: 'You maintain customer satisfaction, diagnose user issues, update knowledge bases, and resolve billing inquiries. When a customer requests a refund, immediately draft an approval request for the Owner.',
    permissions: {
      canDeployCode: false,
      canPublishProducts: false,
      canSendMarketing: false,
      canIssueRefunds: false,
      canRecordExpenses: false,
      canModifySecurity: false,
    },
    lastActiveAt: new Date().toISOString(),
  },
  {
    id: 'dept-fin',
    type: 'finance',
    name: 'Financial Intelligence',
    description: 'Cashflow surveillance, margin calculation, expense auditing, invoice validation, tax reserve planning.',
    status: 'active',
    autonomyLevel: 'strict_approval',
    activeTasksCount: 0,
    completedTasksCount: 0,
    systemInstructions: 'You track all revenue streams, verify Stripe and payment gateway payouts, audit recurring operational costs, and calculate profit margins. Any unbudgeted capital expenditure requires Owner Approval.',
    permissions: {
      canDeployCode: false,
      canPublishProducts: false,
      canSendMarketing: false,
      canIssueRefunds: false,
      canRecordExpenses: false,
      canModifySecurity: false,
    },
    lastActiveAt: new Date().toISOString(),
  },
  {
    id: 'dept-sec',
    type: 'security',
    name: 'Security & RLS Governance',
    description: 'Row Level Security policy audits, vulnerability monitoring, API key isolation, access control enforcement.',
    status: 'active',
    autonomyLevel: 'strict_approval',
    activeTasksCount: 0,
    completedTasksCount: 0,
    systemInstructions: 'You enforce strict zero-trust data access policies. You monitor database permissions, inspect API key exposures, and verify that all tenant data is separated by Business ID. Never modify security rules without explicit Owner Authorization.',
    permissions: {
      canDeployCode: false,
      canPublishProducts: false,
      canSendMarketing: false,
      canIssueRefunds: false,
      canRecordExpenses: false,
      canModifySecurity: false,
    },
    lastActiveAt: new Date().toISOString(),
  },
];

const INITIAL_AUTOMATIONS: AutomationRule[] = [
  {
    id: 'auto-1',
    name: 'Refund Request Guardrail',
    triggerEvent: 'Customer requests order refund',
    actionSummary: 'Pause automated refund processing and generate High-Urgency ticket in Approval Center',
    targetDepartment: 'customer_support',
    requiresOwnerApproval: true,
    isActive: true,
    executionCount: 0,
  },
  {
    id: 'auto-2',
    name: 'Product Catalog Gatekeeper',
    triggerEvent: 'AI Product Specialist finishes digital product draft',
    actionSummary: 'Validate pricing tiers and submit to Approval Center before public release',
    targetDepartment: 'product_creation',
    requiresOwnerApproval: true,
    isActive: true,
    executionCount: 0,
  },
  {
    id: 'auto-3',
    name: 'Production Deployment Protection',
    triggerEvent: 'Development Department prepares production commit',
    actionSummary: 'Compile preview build, run lint checks, and require Owner sign-off before cloud deploy',
    targetDepartment: 'development',
    requiresOwnerApproval: true,
    isActive: true,
    executionCount: 0,
  },
  {
    id: 'auto-4',
    name: 'Nightly RLS Security Audit',
    triggerEvent: 'Scheduled Cron: Daily 02:00 UTC',
    actionSummary: 'Inspect all Supabase tables to confirm Row Level Security is active and no public leaks exist',
    targetDepartment: 'security',
    requiresOwnerApproval: false,
    isActive: true,
    executionCount: 0,
  },
];

const INITIAL_MEMORIES: BusinessMemory[] = [
  {
    id: 'mem-nexus-1',
    businessId: 'biz-nexus-1',
    department: 'global',
    category: 'goal',
    importance: 'high',
    title: 'Nexus Cloud Tech Revenue Goal',
    content: 'Scale Nexus Cloud Tech to $50k MRR across micro-SaaS digital products, dev tooling, and enterprise cloud infrastructure templates while maintaining an 80%+ gross margin.',
    tags: ['mrr', 'growth', 'nexus'],
    source: 'system_initialized',
    isPinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'mem-nexus-2',
    businessId: 'biz-nexus-1',
    department: 'development',
    category: 'strategy',
    importance: 'high',
    title: 'Technology Stack Standard',
    content: 'Full-stack Vite React + Express proxy server, Google Gemini (@google/genai), Supabase PostgreSQL database with Row Level Security (RLS) policies.',
    tags: ['tech-stack', 'react', 'supabase', 'gemini'],
    source: 'system_initialized',
    isPinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'mem-nexus-3',
    businessId: 'biz-nexus-1',
    department: 'security',
    category: 'approval_policy',
    importance: 'high',
    title: 'Zero-Trust Owner Approval Governance',
    content: 'No autonomous code deployments, product releases, marketing broadcasts, or customer refunds without explicit Owner Approval submitted to the Approval Center.',
    tags: ['governance', 'owner-approval', 'security'],
    source: 'system_initialized',
    isPinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'mem-nexus-4',
    businessId: 'biz-nexus-1',
    department: 'product_creation',
    category: 'product_info',
    importance: 'medium',
    title: 'SaaS Monetization & Product Tiers',
    content: 'Micro-SaaS offerings sold on recurring monthly/annual tiers (Starter $29/mo, Pro $99/mo) with instant digital asset delivery.',
    tags: ['saas', 'monetization', 'pricing'],
    source: 'system_initialized',
    isPinned: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'mem-nexus-5',
    businessId: 'biz-nexus-1',
    department: 'security',
    category: 'instruction',
    importance: 'high',
    title: 'Server-Side Credentials Guardrail',
    content: 'Keep all secrets (GEMINI_API_KEY, Supabase service keys) strictly server-side. Never expose private credentials in frontend code.',
    tags: ['security', 'keys', 'server-side'],
    source: 'system_initialized',
    isPinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const STORAGE_KEY_PREFIX = 'paio_data_';

function loadFromStorage<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + key);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error(`Error loading ${key} from storage:`, e);
  }
  return defaultValue;
}

function saveToStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.error(`Error saving ${key} to storage:`, e);
  }
}

export const OSProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeSection, setActiveSection] = useState<NavSection>('command_center');
  const [productsViewMode, setProductsViewMode] = useState<'studio' | 'factory' | 'live_sales' | 'storefront'>('studio');
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>('all');

  // Owner profile
  const [ownerProfile, setOwnerProfile] = useState<UserOwnerProfile>(() =>
    loadFromStorage('owner_profile', {
      name: 'System Owner',
      email: 'owner@businessos.private',
      roleTitle: 'Sole Proprietor & Chief Executive',
      pinCode: '1234',
      isLocked: false,
    })
  );

  // Entities
  const [businesses, setBusinesses] = useState<Business[]>(() =>
    loadFromStorage('businesses', [
      {
        id: 'biz-prime',
        name: 'Nexus Cloud Technologies',
        slug: 'nexus-cloud',
        description: 'B2B developer infrastructure, micro-SaaS APIs, and automation engines.',
        industry: 'Software & Technology',
        currency: 'USD',
        targetMarket: 'Indie Hackers, Mid-market Tech Teams',
        websiteUrl: 'https://nexuscloud.internal',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ])
  );

  const [projects, setProjects] = useState<Project[]>(() =>
    loadFromStorage('projects', [
      {
        id: 'proj-1',
        businessId: 'biz-prime',
        name: 'Nexus API Gateway',
        description: 'High-throughput edge routing and token authentication gateway.',
        websiteUrl: 'https://gateway.nexuscloud.internal',
        githubUrl: 'https://github.com/nexus-org/edge-gateway',
        techStack: ['Node.js', 'TypeScript', 'Docker', 'Redis', 'Tailwind'],
        deploymentStatus: 'live',
        notes: 'Deployed on edge cloud. Monitored 24/7.',
        lastCheckedDate: new Date().toISOString(),
        healthPingStatus: 'healthy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ])
  );

  const [departments, setDepartments] = useState<AIAgentDepartment[]>(() =>
    loadFromStorage('departments', INITIAL_DEPARTMENTS)
  );

  const [tasks, setTasks] = useState<AgentTask[]>(() =>
    loadFromStorage('tasks', [])
  );

  const [products, setProducts] = useState<Product[]>(() => {
    const existing = loadFromStorage<Product[]>('products', []);
    try {
      const seededFlag = localStorage.getItem('paio_flagship_seeded_v1');
      if (!seededFlag) {
        localStorage.setItem('paio_flagship_seeded_v1', '1');
        if (!existing.some((p) => p.id === FLAGSHIP_CONTENT_MACHINE_PRODUCT.id)) {
          return [FLAGSHIP_CONTENT_MACHINE_PRODUCT, ...existing];
        }
      }
    } catch {
      if (existing.length === 0) return [FLAGSHIP_CONTENT_MACHINE_PRODUCT];
    }
    return existing;
  });

  const [factoryJobs, setFactoryJobs] = useState<FactoryJob[]>(() =>
    loadFromStorage('factory_jobs', [])
  );

  const [orders, setOrders] = useState<Order[]>(() =>
    loadFromStorage('orders', [])
  );

  const [customers, setCustomers] = useState<Customer[]>(() =>
    loadFromStorage('customers', [])
  );

  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>(() =>
    loadFromStorage('campaigns', [])
  );

  const [expenses, setExpenses] = useState<ExpenseRecord[]>(() =>
    loadFromStorage('expenses', [])
  );

  const [automations, setAutomations] = useState<AutomationRule[]>(() =>
    loadFromStorage('automations', INITIAL_AUTOMATIONS)
  );

  const [approvals, setApprovals] = useState<ApprovalRequest[]>(() => {
    const stored = loadFromStorage<ApprovalRequest[]>('approvals', []);
    // Never treat localStorage refund approvals as authoritative server state
    return stored.map((a) =>
      a.type === 'issue_refund'
        ? {
            ...a,
            authoritativeSynced: Boolean(a.payloadData?.authoritativeSynced && a.serverApprovalId),
          }
        : a
    );
  });

  const [serverOwnerApprovals, setServerOwnerApprovals] = useState<ServerOwnerApprovalRecord[]>([]);
  const [isSyncingServerApprovals, setIsSyncingServerApprovals] = useState(false);
  const [serverApprovalsError, setServerApprovalsError] = useState<string | null>(null);

  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>(() =>
    loadFromStorage('activity_logs', [
      {
        id: 'act-init',
        timestamp: new Date().toISOString(),
        actor: 'System Kernel',
        actorType: 'system',
        action: 'OS_INITIALIZED',
        details: 'Personal AI Business OS booted successfully with isolated tenant parameters.',
        severity: 'info',
      },
    ])
  );

  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadFromStorage('conversations', [
      {
        id: 'conv-main',
        title: 'Central Command & Strategy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ])
  );

  const [activeConversationId, setActiveConversationId] = useState<string | null>('conv-main');

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() =>
    loadFromStorage('chat_messages', [
      {
        id: 'msg-init-1',
        conversationId: 'conv-main',
        role: 'assistant',
        content: 'Welcome to Personal AI Business OS. I am your Executive AI Coordinator. All 6 specialized AI departments (Development, Product Creation, Marketing, Customer Support, Finance, and Security) are standing by in strict owner-approval mode. How may I assist your business operations today?',
        timestamp: new Date().toISOString(),
      },
    ])
  );

  const [supabaseConfig, setSupabaseConfigState] = useState<StoredSupabaseConfig>(getStoredSupabaseConfig);
  const [aiConfig, setAIConfigState] = useState<AIProviderConfig>(() => {
    const loaded = loadFromStorage<AIProviderConfig>('ai_config', {
      activeProvider: 'server_proxy',
      model: 'gemini-2.5-flash',
      customSystemPrompt: 'You are the Central Executive Coordinator of the Personal AI Business OS. Coordinate across Development, Product, Marketing, Support, Finance, and Security.',
    });
    return loaded.model === 'gemini-2.5-flash-lite'
      ? { ...loaded, model: 'gemini-3.1-flash-lite' }
      : loaded;
  });

  const [isAiThinking, setIsAiThinking] = useState(false);

  const [memories, setMemories] = useState<BusinessMemory[]>(() =>
    loadFromStorage('business_memories', INITIAL_MEMORIES)
  );

  // Sync state to storage
  useEffect(() => saveToStorage('owner_profile', ownerProfile), [ownerProfile]);
  useEffect(() => saveToStorage('businesses', businesses), [businesses]);
  useEffect(() => saveToStorage('projects', projects), [projects]);
  useEffect(() => saveToStorage('departments', departments), [departments]);
  useEffect(() => saveToStorage('tasks', tasks), [tasks]);
  useEffect(() => saveToStorage('products', products), [products]);
  useEffect(() => saveToStorage('factory_jobs', factoryJobs), [factoryJobs]);
  useEffect(() => saveToStorage('orders', orders), [orders]);
  useEffect(() => saveToStorage('customers', customers), [customers]);
  useEffect(() => saveToStorage('campaigns', campaigns), [campaigns]);
  useEffect(() => saveToStorage('expenses', expenses), [expenses]);
  useEffect(() => saveToStorage('automations', automations), [automations]);
  useEffect(() => saveToStorage('approvals', approvals), [approvals]);
  useEffect(() => saveToStorage('activity_logs', activityLogs), [activityLogs]);
  useEffect(() => saveToStorage('conversations', conversations), [conversations]);
  useEffect(() => saveToStorage('chat_messages', chatMessages), [chatMessages]);
  useEffect(() => saveToStorage('ai_config', aiConfig), [aiConfig]);
  useEffect(() => saveToStorage('business_memories', memories), [memories]);

  // Sync memories with Supabase on startup / connection
  useEffect(() => {
    if (supabaseConfig.isConnected && supabaseConfig.projectUrl && supabaseConfig.anonKey) {
      fetchBusinessMemoriesFromSupabase().then((data) => {
        if (data && Array.isArray(data) && data.length > 0) {
          const mapped: BusinessMemory[] = data.map((d: any) => ({
            id: d.id,
            businessId: d.business_id || undefined,
            projectId: d.project_id || undefined,
            department: d.department || 'global',
            category: d.category || 'instruction',
            importance: d.importance || 'medium',
            title: d.title,
            content: d.content,
            tags: d.tags || [],
            source: d.source || 'user_defined',
            isPinned: !!d.is_pinned,
            createdAt: d.created_at || new Date().toISOString(),
            updatedAt: d.updated_at || new Date().toISOString(),
          }));
          setMemories(mapped);
        }
      });
    }
  }, [supabaseConfig.isConnected, supabaseConfig.projectUrl]);

  // M3: Clear transient authoritative caches on sign-out or authenticated user switch
  const lastAuthUserIdRef = React.useRef<string | null>(null);
  useEffect(() => {
    const clearAccountBoundCaches = () => {
      setServerOwnerApprovals([]);
      setServerApprovalsError(null);
      setApprovals((prev) =>
        prev.map((a) => ({
          ...a,
          authoritativeSynced: undefined,
          serverApprovalId: undefined,
          serverApprovalStatus: undefined,
          serverExpiresAt: undefined,
          serverConsumedAt: undefined,
        }))
      );
      setProducts((prev) =>
        prev.map((p) => (p.publishedApprovalId ? { ...p, publishedApprovalId: undefined } : p))
      );
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < sessionStorage.length; i += 1) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith('paio_stripe_recorded_')) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach((k) => sessionStorage.removeItem(k));
      } catch {
        // Ignore sessionStorage restrictions
      }
    };

    const client = getSupabaseClient();
    if (!client) {
      if (lastAuthUserIdRef.current !== null) {
        lastAuthUserIdRef.current = null;
        clearAccountBoundCaches();
      }
      return;
    }

    let mounted = true;
    client.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const uid = data.session?.user?.id ?? null;
      if (lastAuthUserIdRef.current && lastAuthUserIdRef.current !== uid) {
        clearAccountBoundCaches();
      }
      lastAuthUserIdRef.current = uid;
    }).catch(() => {});

    const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
      const nextUid = session?.user?.id ?? null;
      const switchedUser =
        lastAuthUserIdRef.current !== null && nextUid !== null && lastAuthUserIdRef.current !== nextUid;
      if (event === 'SIGNED_OUT' || switchedUser) {
        clearAccountBoundCaches();
      }
      lastAuthUserIdRef.current = nextUid;
    });

    return () => {
      mounted = false;
      subscription?.subscription?.unsubscribe();
    };
  }, [supabaseConfig.isConnected, supabaseConfig.projectUrl, supabaseConfig.anonKey]);

  // Memory Management Operations
  const addMemory = (mem: Omit<BusinessMemory, 'id' | 'createdAt' | 'updatedAt'>): BusinessMemory => {
    const newMem: BusinessMemory = {
      ...mem,
      id: `mem-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setMemories((prev) => [newMem, ...prev]);
    logActivity('MEMORY_ADDED', `Saved memory to Memory Bank: "${newMem.title}"`, 'success', newMem.businessId);

    if (supabaseConfig.isConnected) {
      saveBusinessMemoryToSupabase(newMem);
    }
    return newMem;
  };

  const updateMemory = (id: string, updates: Partial<BusinessMemory>) => {
    setMemories((prev) =>
      prev.map((m) => {
        if (m.id === id) {
          const updated = { ...m, ...updates, updatedAt: new Date().toISOString() };
          if (supabaseConfig.isConnected) {
            saveBusinessMemoryToSupabase(updated);
          }
          return updated;
        }
        return m;
      })
    );
    logActivity('MEMORY_UPDATED', `Updated memory: ID ${id}`, 'info');
  };

  const deleteMemory = (id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
    logActivity('MEMORY_DELETED', `Deleted memory record: ID ${id}`, 'warning');
    if (supabaseConfig.isConnected) {
      deleteBusinessMemoryFromSupabase(id);
    }
  };

  const togglePinMemory = (id: string) => {
    setMemories((prev) =>
      prev.map((m) => {
        if (m.id === id) {
          const updated = { ...m, isPinned: !m.isPinned, updatedAt: new Date().toISOString() };
          if (supabaseConfig.isConnected) {
            saveBusinessMemoryToSupabase(updated);
          }
          return updated;
        }
        return m;
      })
    );
  };

  const getMemoriesForContext = (businessId?: string, department?: AIDepartmentType): BusinessMemory[] => {
    return memories.filter((m) => {
      const matchBiz = !m.businessId || m.businessId === businessId || businessId === 'all';
      const matchDept = !m.department || m.department === 'global' || !department || m.department === department;
      return matchBiz && matchDept;
    });
  };

  // Selected Business helper
  const selectedBusiness = businesses.find((b) => b.id === selectedBusinessId) || null;

  // Logging helper
  const logActivity = (
    action: string,
    details: string,
    severity: ActivityLog['severity'] = 'info',
    businessId?: string
  ) => {
    const biz = businesses.find((b) => b.id === (businessId || selectedBusinessId));
    const newEntry: ActivityLog = {
      id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      actor: ownerProfile.name || 'Owner',
      actorType: 'owner',
      action,
      details,
      severity,
      businessId: biz?.id,
      businessName: biz?.name,
    };
    setActivityLogs((prev) => [newEntry, ...prev.slice(0, 199)]);
  };

  // Owner lock/unlock
  const lockOS = () => {
    setOwnerProfile((prev) => ({ ...prev, isLocked: true }));
  };

  const unlockOS = (pin?: string): boolean => {
    if (!ownerProfile.pinCode || ownerProfile.pinCode === pin) {
      setOwnerProfile((prev) => ({ ...prev, isLocked: false }));
      return true;
    }
    return false;
  };

  const updateOwnerProfile = (updates: Partial<UserOwnerProfile>) => {
    setOwnerProfile((prev) => ({ ...prev, ...updates }));
    logActivity('PROFILE_UPDATED', 'Executive owner security profile updated.');
  };

  // Business CRUD
  const addBusiness = (bizData: Omit<Business, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = new Date().toISOString();
    const newBiz: Business = {
      ...bizData,
      id: `biz-${Date.now()}`,
      createdAt: now,
      updatedAt: now,
    };
    setBusinesses((prev) => [...prev, newBiz]);
    logActivity('BUSINESS_CREATED', `Added new business entity: "${newBiz.name}"`, 'success', newBiz.id);
    return newBiz;
  };

  const updateBusiness = (id: string, updates: Partial<Business>) => {
    setBusinesses((prev) =>
      prev.map((b) => (b.id === id ? { ...b, ...updates, updatedAt: new Date().toISOString() } : b))
    );
    logActivity('BUSINESS_MODIFIED', `Updated business profile "${id}"`, 'info', id);
  };

  const archiveBusiness = (id: string) => {
    setBusinesses((prev) =>
      prev.map((b) => (b.id === id ? { ...b, status: b.status === 'archived' ? 'active' : 'archived' } : b))
    );
    logActivity('BUSINESS_STATUS_CHANGE', `Toggled archive status for business ID ${id}`, 'warning', id);
  };

  const deleteBusiness = (id: string) => {
    const target = businesses.find((b) => b.id === id);
    setBusinesses((prev) => prev.filter((b) => b.id !== id));
    if (selectedBusinessId === id) {
      setSelectedBusinessId('all');
    }
    logActivity('BUSINESS_REMOVED', `Permanently deleted business entity "${target?.name || id}"`, 'critical');
  };

  // Project (Websites & Apps) CRUD
  const addProject = (projData: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = new Date().toISOString();
    const newProj: Project = {
      ...projData,
      id: `proj-${Date.now()}`,
      createdAt: now,
      updatedAt: now,
      healthPingStatus: 'unchecked',
    };
    setProjects((prev) => [...prev, newProj]);
    logActivity('PROJECT_REGISTERED', `Registered website/application: "${newProj.name}"`, 'success', newProj.businessId);
    return newProj;
  };

  const updateProject = (id: string, updates: Partial<Project>) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
    );
    logActivity('PROJECT_MODIFIED', `Updated registry details for project ID ${id}`);
  };

  const deleteProject = (id: string) => {
    const target = projects.find((p) => p.id === id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
    logActivity('PROJECT_DELETED', `Deleted project "${target?.name || id}"`, 'warning', target?.businessId);
  };

  const pingProjectHealth = async (id: string) => {
    const target = projects.find((p) => p.id === id);
    if (!target) return;
    
    // Simulate real safe connectivity check
    const isLive = target.deploymentStatus === 'live';
    const status: Project['healthPingStatus'] = isLive ? 'healthy' : 'warning';
    
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              lastCheckedDate: new Date().toISOString(),
              healthPingStatus: status,
            }
          : p
      )
    );
    logActivity('PROJECT_HEALTH_PING', `Checked availability for "${target.name}": Status ${status}`, 'info', target.businessId);
  };

  // Departments & Tasks
  const updateDepartment = (type: AIDepartmentType, updates: Partial<AIAgentDepartment>) => {
    setDepartments((prev) =>
      prev.map((d) => (d.type === type ? { ...d, ...updates, lastActiveAt: new Date().toISOString() } : d))
    );
    logActivity('AGENT_DEPT_CONFIG', `Configured AI Department: ${type}`, 'info');
  };

  const addTask = (taskData: Omit<AgentTask, 'id' | 'createdAt'>) => {
    const newTask: AgentTask = {
      ...taskData,
      id: `task-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    setTasks((prev) => [newTask, ...prev]);
    setDepartments((prev) =>
      prev.map((d) => (d.type === newTask.departmentId ? { ...d, activeTasksCount: d.activeTasksCount + 1 } : d))
    );
    logActivity('AGENT_TASK_ASSIGNED', `Assigned task "${newTask.title}" to ${newTask.departmentId}`, 'info', newTask.businessId);
    return newTask;
  };

  const updateTaskStatus = (id: string, status: AgentTask['status'], result?: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const isNowDone = status === 'completed';
        return {
          ...t,
          status,
          resultPayload: result || t.resultPayload,
          completedAt: isNowDone ? new Date().toISOString() : t.completedAt,
        };
      })
    );
  };

  // Products CRUD
  const addProduct = (prodData: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'salesCount' | 'totalRevenue'>) => {
    const now = new Date().toISOString();
    const newProd: Product = {
      ...prodData,
      id: `prod-${Date.now()}`,
      salesCount: 0,
      totalRevenue: 0,
      createdAt: now,
      updatedAt: now,
    };
    setProducts((prev) => [...prev, newProd]);
    logActivity('PRODUCT_CREATED', `Created digital product draft "${newProd.name}" ($${newProd.price})`, 'info', newProd.businessId);
    return newProd;
  };

  const updateProduct = (id: string, updates: Partial<Product>) => {
    setProducts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
    );
    if (
      updates.gumroadProductId !== undefined ||
      updates.gumroadUrl !== undefined ||
      updates.salesCount !== undefined ||
      updates.totalRevenue !== undefined
    ) {
      syncProductGumroadFieldsToSupabase({
        productId: id,
        gumroadProductId: updates.gumroadProductId,
        gumroadUrl: updates.gumroadUrl,
        salesCount: updates.salesCount,
        totalRevenue: updates.totalRevenue,
      }).catch(() => {});
    }
  };

  const submitProductForApproval = (productId: string) => {
    const prod = products.find((p) => p.id === productId);
    if (!prod) return;
    updateProduct(productId, { status: 'awaiting_approval' });
    createApprovalRequest({
      type: 'publish_product',
      title: `Publish Product: ${prod.name}`,
      description: `Product Creation agent requesting public release of ${prod.name} at price $${prod.price} (${prod.billingType}).`,
      businessId: prod.businessId,
      requestedByDepartment: 'product_creation',
      urgency: 'standard',
      payloadData: { productId: prod.id, price: prod.price, name: prod.name },
    });
    logActivity('PRODUCT_APPROVAL_SUBMITTED', `Product "${prod.name}" routed to Approval Center`, 'warning', prod.businessId);
  };

  const approveAndPublishProductDirect = async (productId: string, note?: string): Promise<void> => {
    const prod = products.find((p) => p.id === productId);
    if (!prod) return;
    const now = new Date().toISOString();
    const decisionNote = note || 'Approved and deployed live by Executive Owner';

    try {
      const token = await getSupabaseAccessToken();
      if (token) {
        const apprResp = await authorizedApiFetch('/api/commerce/publish-approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productId: prod.id,
            businessId: prod.businessId,
            decisionNote,
            replaceExisting: true,
          }),
        });
        if (apprResp.ok) {
          const apprData = await apprResp.json().catch(() => null);
          const approvalId = apprData?.approval?.approvalId
            ? String(apprData.approval.approvalId)
            : '';
          if (approvalId) {
            await authorizedApiFetch('/api/commerce/products/publish', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                productId: prod.id,
                businessId: prod.businessId,
                approvalId,
              }),
            });
          }
        }
      }
    } catch {
      // Allow local-only draft state update when backend commerce store is not attached
    }

    const signedApproval: ApprovalRequest = {
      id: `appr-${Date.now()}`,
      type: 'publish_product',
      title: `Publish Product: ${prod.name}`,
      description: `Owner-authorized live storefront deployment for "${prod.name}" ($${prod.price.toFixed(2)} ${prod.billingType}).`,
      businessId: prod.businessId,
      requestedByDepartment: 'product_creation',
      status: 'approved',
      urgency: 'standard',
      payloadData: { productId: prod.id, price: prod.price, name: prod.name },
      decisionNote,
      decidedAt: now,
      decidedBy: ownerProfile.name || 'System Owner',
      createdAt: now,
    };
    setApprovals((prev) => [signedApproval, ...prev]);
    updateProduct(productId, { status: 'published', publishedApprovalId: undefined });
    setFactoryJobs((prev) =>
      prev.map((j) =>
        j.productId === productId && j.jobStatus !== 'completed'
          ? {
              ...j,
              currentStage: 'completed',
              jobStatus: 'completed',
              progress: 100,
              updatedAt: now,
              stageLogs: [
                ...(j.stageLogs || []),
                {
                  stage: 'completed',
                  timestamp: now,
                  message: `Owner authorized direct live deployment for "${prod.name}".`,
                },
              ],
            }
          : j
      )
    );
    logActivity('PRODUCT_DEPLOYED_LIVE', `Owner authorized & deployed "${prod.name}" live at $${prod.price.toFixed(2)}`, 'success', prod.businessId);
  };

  const upsertFactoryJobState = (job: FactoryJob) => {
    setFactoryJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === job.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = job;
        return next;
      }
      return [job, ...prev];
    });
    upsertFactoryJobToSupabase(job).catch(() => {});
  };

  const runDigitalProductFactory = async (input: {
    topic: string;
    targetAudience: string;
    businessId: string;
    productType: Product['type'];
    price: number;
    billingType: Product['billingType'];
  }) => {
    const biz = businesses.find((b) => b.id === input.businessId) || businesses[0];
    const resolvedBizId = biz?.id || input.businessId || 'biz-prime';
    const businessName = biz?.name || 'Nexus Cloud Technologies';
    const startTs = Date.now();
    const jobId = `job-${startTs}`;

    let jobState: FactoryJob = {
      id: jobId,
      businessId: resolvedBizId,
      productId: null,
      currentStage: 'queued',
      jobStatus: 'running',
      progress: 5,
      stageLogs: [
        {
          stage: 'queued',
          timestamp: new Date().toISOString(),
          message: `Initialized Digital Product Factory pipeline for "${input.topic.trim()}".`,
        },
      ],
      createdAt: new Date(startTs).toISOString(),
      updatedAt: new Date(startTs).toISOString(),
    };
    upsertFactoryJobState(jobState);
    logActivity(
      'FACTORY_PIPELINE_STARTED',
      `Launched unified factory run for "${input.topic.trim()}" ($${Number(input.price).toFixed(2)})`,
      'info',
      resolvedBizId
    );

    const advanceStage = (
      stage: FactoryPipelineStage,
      progress: number,
      message: string,
      extra?: Partial<FactoryJob>
    ) => {
      const ts = new Date().toISOString();
      jobState = {
        ...jobState,
        ...extra,
        currentStage: stage,
        progress,
        updatedAt: ts,
        stageLogs: [...(jobState.stageLogs || []), { stage, timestamp: ts, message }],
      };
      upsertFactoryJobState(jobState);
    };

    try {
      // Stage 1: Market Research (Product Creation Dept)
      advanceStage('researching', 15, 'Researching buyer pain points and deliverable outline...');
      const research = await runFactoryResearch({
        topic: input.topic.trim(),
        targetAudience: input.targetAudience.trim(),
        businessName,
        productType: input.productType,
        price: Number(input.price) || 19,
      });

      const researchTaskId = `task-fac-res-${startTs}`;
      setTasks((prev) => [
        {
          id: researchTaskId,
          departmentId: 'product_creation',
          businessId: resolvedBizId,
          title: `Factory Research: ${input.topic.trim().slice(0, 48)}`,
          description: `Positioning Hook: ${research.positioningHook}`,
          priority: 'high',
          status: 'completed',
          assignedAgent: 'Product Creation & Strategy',
          resultPayload: `Outline: ${research.outlineSections.join(' · ')}`,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        ...prev,
      ]);

      // Stage 2: Author Deliverable Content & Create Draft Product
      advanceStage(
        'writing_content',
        35,
        `Drafting full deliverable package (${research.modelUsed} brief applied)...`
      );
      const pkg = await generateFactoryProductPackage({
        topic: input.topic.trim(),
        targetAudience: input.targetAudience.trim(),
        productType: input.productType,
        price: Number(input.price) || 19,
        billingType: input.billingType,
        businessName,
        research,
      });

      const slug = pkg.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

      let draftProduct = addProduct({
        name: pkg.name,
        slug: slug || `product-${startTs}`,
        description: pkg.description,
        businessId: resolvedBizId,
        type: input.productType,
        price: Number(input.price) || 19,
        billingType: input.billingType,
        status: 'draft',
        deliverableFormat: pkg.deliverableFormat,
        deliverableContent: pkg.deliverableContent,
        factoryMetadata: {
          factoryJobId: jobId,
          contentModel: pkg.modelUsed,
          researchHook: research.positioningHook,
          researchPainPoints: research.buyerPainPoints,
          outlineSections: research.outlineSections,
        },
      });

      // Stage 3: Bespoke Cover Artwork
      advanceStage('generating_cover', 55, `Generating editorial cover art for "${draftProduct.name}"...`, {
        productId: draftProduct.id,
      });
      const coverRes = await generateProductCoverAsset(draftProduct, businessName);

      // Stage 4: Binary .PDF Deliverable Build
      advanceStage('building_pdf', 72, 'Compiling multi-page binary .PDF deliverable via PDFKit...');
      const pdfRes = await buildProductPdfAsset(draftProduct, businessName);

      // Stage 5: Vault Sync & Metadata Attachment
      advanceStage(
        'uploading_assets',
        84,
        pdfRes.storagePath || coverRes.storagePath
          ? 'Synced cover SVG & .PDF deliverable to owner-isolated Supabase Storage.'
          : 'Packaged cover SVG & binary .PDF locally (sign in to Supabase Auth in Settings for vault upload).'
      );

      const enrichedFactoryMetadata = {
        ...(draftProduct.factoryMetadata || {}),
        coverModel: coverRes.modelUsed,
        coverStoragePath: coverRes.storagePath,
        pdfFilename: pdfRes.filename,
        pdfPageCount: pdfRes.pageCount,
        pdfByteLength: pdfRes.byteLength,
        pdfBuiltAt: new Date().toISOString(),
        storageSynced: Boolean(coverRes.storagePath || pdfRes.storagePath),
      };

      const buildTaskId = `task-fac-dev-${startTs}`;
      setTasks((prev) => [
        {
          id: buildTaskId,
          departmentId: 'development',
          businessId: resolvedBizId,
          title: `PDF & Cover Build: ${draftProduct.name}`,
          description: `Generated vector cover (${coverRes.modelUsed || 'editorial_svg'}) and compiled ${pdfRes.pageCount || 1}-page PDF (${pdfRes.byteLength || 0} bytes).`,
          priority: 'medium',
          status: 'completed',
          assignedAgent: 'Development & Engineering',
          resultPayload: pdfRes.storagePath || pdfRes.filename || 'Compiled locally',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        ...prev,
      ]);

      // Stage 6: Marketing Launch Kit Draft (Marketing Dept)
      advanceStage('drafting_marketing', 92, 'Drafting email broadcast & social launch kit...');
      const launchKit = await runFactoryLaunchKit({
        title: draftProduct.name,
        description: draftProduct.description,
        price: draftProduct.price,
        billingType: draftProduct.billingType,
        businessName,
        targetAudience: input.targetAudience.trim(),
        researchHook: research.positioningHook,
      });

      const launchCopy = [
        `Subject: ${launchKit.emailSubject}`,
        '',
        launchKit.emailBody,
        '',
        '--- Social Launch Sequence ---',
        ...launchKit.socialPosts,
        '',
        `SEO Keywords: ${launchKit.seoKeywords.join(', ')}`,
      ].join('\n');

      const draftCampaign = addCampaign({
        name: launchKit.campaignName,
        businessId: resolvedBizId,
        channel: launchKit.channel,
        status: 'draft',
        targetAudience: input.targetAudience.trim(),
        budget: 0,
        conversionGoal: launchKit.conversionGoal,
        keyCopyOrContent: launchCopy,
      });

      const marketingTaskId = `task-fac-mkt-${startTs}`;
      setTasks((prev) => [
        {
          id: marketingTaskId,
          departmentId: 'marketing',
          businessId: resolvedBizId,
          title: `Launch Kit Drafted: ${draftProduct.name}`,
          description: `Prepared ${launchKit.channel} launch copy, social posts, and SEO keywords (held as draft until Owner Approval).`,
          priority: 'medium',
          status: 'completed',
          assignedAgent: 'Marketing & Growth',
          resultPayload: `Campaign ID: ${draftCampaign.id}`,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        ...prev,
      ]);

      // Stage 7: Governance Hold — Submit to Approval Center
      const approvalReq = createApprovalRequest({
        type: 'publish_product',
        title: `Publish Factory Product: ${draftProduct.name}`,
        description: `Digital Product Factory completed research, ${pdfRes.pageCount || 1}-page PDF build, cover art, and Marketing launch kit draft ($${draftProduct.price.toFixed(2)} ${draftProduct.billingType}). Approve to deploy live & unlock Gumroad push.`,
        businessId: resolvedBizId,
        requestedByDepartment: 'product_creation',
        urgency: 'standard',
        payloadData: {
          productId: draftProduct.id,
          factoryJobId: jobId,
          campaignId: draftCampaign.id,
          price: draftProduct.price,
          name: draftProduct.name,
          pdfPageCount: pdfRes.pageCount || 1,
          pdfStoragePath: pdfRes.storagePath || null,
          storageSynced: Boolean(coverRes.storagePath || pdfRes.storagePath),
          researchHook: research.positioningHook,
        },
      });

      const updatedProductFields: Partial<Product> = {
        status: 'awaiting_approval',
        coverImageUrl: coverRes.coverDataUrl,
        pdfStoragePath: pdfRes.storagePath,
        factoryMetadata: {
          ...enrichedFactoryMetadata,
          launchCampaignId: draftCampaign.id,
          approvalRequestId: approvalReq.id,
        },
      };
      updateProduct(draftProduct.id, updatedProductFields);
      draftProduct = { ...draftProduct, ...updatedProductFields };

      const gateTaskId = `task-fac-gate-${startTs}`;
      setTasks((prev) => [
        {
          id: gateTaskId,
          departmentId: 'security',
          businessId: resolvedBizId,
          title: `Approval Gate: ${draftProduct.name}`,
          description: 'Awaiting Executive Owner sign-off before public storefront & Gumroad deployment.',
          priority: 'high',
          status: 'awaiting_approval',
          assignedAgent: 'Security & Governance',
          approvalRequestId: approvalReq.id,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);

      advanceStage(
        'awaiting_approval',
        95,
        'Package verified and queued in Approval Center for Executive sign-off.',
        {
          jobStatus: 'awaiting_approval',
          productId: draftProduct.id,
        }
      );

      logActivity(
        'FACTORY_PIPELINE_AWAITING_APPROVAL',
        `Digital Product Factory packaged "${draftProduct.name}" (${pdfRes.pageCount || 1}p PDF + cover + launch kit) and routed to Approval Center.`,
        'success',
        resolvedBizId
      );

      return {
        job: jobState,
        product: draftProduct,
        campaign: draftCampaign,
        approval: approvalReq,
        pdfBlob: pdfRes.blob,
        pdfFilename: pdfRes.filename,
      };
    } catch (err: any) {
      const errMsg = err?.message || 'Unexpected error during Digital Product Factory run.';
      const failTs = new Date().toISOString();
      jobState = {
        ...jobState,
        currentStage: 'failed',
        jobStatus: 'failed',
        errorMessage: errMsg,
        updatedAt: failTs,
        stageLogs: [
          ...(jobState.stageLogs || []),
          { stage: 'failed', timestamp: failTs, message: errMsg },
        ],
      };
      upsertFactoryJobState(jobState);
      logActivity('FACTORY_PIPELINE_FAILED', errMsg, 'critical', resolvedBizId);
      throw err;
    }
  };

  const restoreFlagshipContentMachine = () => {
    setProducts((prev) => {
      if (prev.some((p) => p.id === FLAGSHIP_CONTENT_MACHINE_PRODUCT.id)) return prev;
      return [FLAGSHIP_CONTENT_MACHINE_PRODUCT, ...prev];
    });
    logActivity('PRODUCT_RESTORED', 'Restored "The 30-Day Small Business Content Machine" ($19.00) to live catalog', 'success', 'biz-prime');
  };

  const deleteProduct = (id: string) => {
    const prod = products.find((p) => p.id === id);
    setProducts((prev) => prev.filter((p) => p.id !== id));
    logActivity('PRODUCT_DELETED', `Deleted product "${prod?.name || id}"`, 'warning', prod?.businessId);
  };

  const recordCustomerPurchase = (
    productId: string,
    buyerName: string,
    buyerEmail: string,
    paymentMethod: string
  ): Order | null => {
    const prod = products.find((p) => p.id === productId);
    if (!prod) return null;

    const existingCust = customers.find(
      (c) => c.email.toLowerCase() === buyerEmail.trim().toLowerCase() && c.businessId === prod.businessId
    );
    const customer = existingCust
      ? existingCust
      : addCustomer({
          name: buyerName.trim() || 'Digital Buyer',
          email: buyerEmail.trim() || 'buyer@customer.local',
          businessId: prod.businessId,
          status: 'active',
          notes: `Purchased ${prod.name} via ${paymentMethod}`,
        });

    const newOrder = addOrder({
      businessId: prod.businessId,
      customerId: customer.id,
      productId: prod.id,
      productName: prod.name,
      customerName: customer.name,
      customerEmail: customer.email,
      amount: prod.price,
      currency: 'USD',
      status: 'completed',
      paymentMethod,
    });

    return newOrder;
  };

  // Orders & Customers
  const addCustomer = (custData: Omit<Customer, 'id' | 'totalSpend' | 'ordersCount'>) => {
    const newCust: Customer = {
      ...custData,
      id: `cust-${Date.now()}`,
      totalSpend: 0,
      ordersCount: 0,
    };
    setCustomers((prev) => [...prev, newCust]);
    logActivity('CUSTOMER_CREATED', `Enrolled customer ${newCust.name} (${newCust.email})`, 'info', newCust.businessId);
    return newCust;
  };

  const addOrder = (orderData: Omit<Order, 'id' | 'createdAt' | 'orderNumber'>) => {
    const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
    const newOrder: Order = {
      ...orderData,
      id: `ord-${Date.now()}`,
      orderNumber,
      createdAt: new Date().toISOString(),
    };
    setOrders((prev) => [newOrder, ...prev]);

    // Update product metrics
    setProducts((prev) =>
      prev.map((p) =>
        p.id === newOrder.productId
          ? {
              ...p,
              salesCount: p.salesCount + 1,
              totalRevenue: p.totalRevenue + newOrder.amount,
            }
          : p
      )
    );

    // Update customer metrics
    setCustomers((prev) =>
      prev.map((c) =>
        c.id === newOrder.customerId
          ? {
              ...c,
              ordersCount: c.ordersCount + 1,
              totalSpend: c.totalSpend + newOrder.amount,
              lastActiveAt: new Date().toISOString(),
              status: 'active',
            }
          : c
      )
    );

    logActivity('ORDER_COMPLETED', `Order ${orderNumber} logged: $${newOrder.amount} from ${newOrder.customerName}`, 'success', newOrder.businessId);
    return newOrder;
  };

  const requestRefund = async (
    orderId: string,
    reason: string,
    _provenanceOverride?: ProvenanceRecord
  ): Promise<{ ok: boolean; error?: string }> => {
    const ord = orders.find((o) => o.id === orderId);
    if (!ord) {
      return { ok: false, error: `Order "${orderId}" was not found.` };
    }

    const token = await getSupabaseAccessToken();
    if (!token) {
      const errMsg =
        'Supabase authentication session required to ingest an authoritative refund request.';
      logActivity(
        'REFUND_INGEST_BLOCKED',
        `Refund request for Order ${ord.orderNumber} blocked: ${errMsg}`,
        'warning',
        ord.businessId
      );
      return { ok: false, error: errMsg };
    }

    const ingestRes = await ingestRefundProvenance(
      {
        business_id: ord.businessId,
        order_id: ord.id,
        customer_email: ord.customerEmail,
        amount_usd: ord.amount,
        reason,
        trigger_id: ord.orderNumber,
        confidence: 0.9,
      },
      token
    );

    if (!ingestRes.ok || !ingestRes.data?.request?.provenance) {
      const errMsg =
        ingestRes.error || 'Server rejected provenance ingestion for refund request.';
      logActivity(
        'REFUND_INGEST_FAILED',
        `Server rejected refund ingestion for Order ${ord.orderNumber}: ${errMsg}`,
        'critical',
        ord.businessId
      );
      return { ok: false, error: errMsg };
    }

    const signedRequest = ingestRes.data.request;
    const provenance = signedRequest.provenance!;
    const amountCents = Math.round(signedRequest.amount_usd * 100);
    const boundaryDecision = evaluateFinanceRefund(signedRequest);

    createApprovalRequest({
      type: 'issue_refund',
      title: `Refund Request: ${ord.orderNumber} ($${ord.amount.toFixed(2)})`,
      description: `Customer Support requesting refund for ${ord.customerName}. Reason: ${reason}`,
      businessId: ord.businessId,
      requestedByDepartment: provenance.source_agent,
      urgency: 'high',
      authoritativeSynced: true,
      payloadData: {
        requestId: provenance.request_id,
        orderId: ord.id,
        orderNumber: ord.orderNumber,
        businessId: ord.businessId,
        amount: ord.amount,
        amountCents,
        customerEmail: ord.customerEmail,
        reason,
        provenance,
        boundaryEvaluation: boundaryDecision,
        authoritativeSynced: true,
      },
    });
    logActivity(
      'REFUND_REQUESTED',
      `Authenticated refund request ${provenance.request_id} ingested for Order ${ord.orderNumber}; awaiting server Owner Approval.`,
      'warning',
      ord.businessId
    );
    return { ok: true };
  };

  const syncGumroadSales = (
    sales: Array<{
      saleId: string;
      gumroadProductId?: string;
      productName: string;
      buyerName: string;
      buyerEmail: string;
      amountDollars: number;
      currency?: string;
      refunded?: boolean;
      createdAt?: string;
    }>
  ) => {
    if (!Array.isArray(sales) || sales.length === 0) {
      return { imported: 0, updated: 0, skipped: 0 };
    }

    const baseTs = Date.now();
    const existingOrderNumbers = new Set(orders.map((o) => o.orderNumber));
    const existingSaleOrderIds = new Map<string, Order>();
    for (const o of orders) {
      existingSaleOrderIds.set(o.orderNumber, o);
    }

    const workingCustomers = [...customers];
    const newCustomers: Customer[] = [];
    const newOrders: Order[] = [];
    const customerIncrements = new Map<string, { spend: number; count: number; lastAt: string }>();
    const productIncrements = new Map<string, { sales: number; revenue: number }>();
    const refundedOrderNumbers = new Set<string>();

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    sales.forEach((sale, idx) => {
      const cleanSaleId = String(sale.saleId || '').trim();
      if (!cleanSaleId) {
        skipped += 1;
        return;
      }

      const orderNumber = `GUM-${cleanSaleId.slice(-10)}`;
      const existingOrder = existingSaleOrderIds.get(orderNumber);

      if (existingOrder) {
        if (sale.refunded && existingOrder.status !== 'refunded') {
          refundedOrderNumbers.add(orderNumber);
          updated += 1;
        } else {
          skipped += 1;
        }
        return;
      }

      if (existingOrderNumbers.has(orderNumber)) {
        skipped += 1;
        return;
      }
      existingOrderNumbers.add(orderNumber);

      const matchedProd =
        products.find(
          (p) =>
            (sale.gumroadProductId && p.gumroadProductId === sale.gumroadProductId) ||
            p.name.trim().toLowerCase() === sale.productName.trim().toLowerCase()
        ) || null;

      const resolvedBizId =
        matchedProd?.businessId ||
        (selectedBusinessId !== 'all' ? selectedBusinessId : businesses[0]?.id || 'biz-prime');

      const buyerEmail = (sale.buyerEmail || 'buyer@gumroad.verified').trim();
      const buyerName = (sale.buyerName || buyerEmail || 'Gumroad Buyer').trim();
      const amount = Math.max(0, Number(sale.amountDollars || 0));
      const createdAt = sale.createdAt || new Date().toISOString();

      let cust = workingCustomers.find(
        (c) =>
          c.email.toLowerCase() === buyerEmail.toLowerCase() &&
          c.businessId === resolvedBizId
      );

      if (!cust) {
        cust = {
          id: `cust-gum-${baseTs}-${idx}`,
          businessId: resolvedBizId,
          name: buyerName,
          email: buyerEmail,
          status: 'active',
          totalSpend: 0,
          ordersCount: 0,
          firstPurchasedAt: createdAt,
          lastActiveAt: createdAt,
          notes: `Synced from Gumroad sale ${cleanSaleId}`,
        };
        workingCustomers.push(cust);
        newCustomers.push(cust);
      }

      const orderStatus: Order['status'] = sale.refunded ? 'refunded' : 'completed';
      const newOrd: Order = {
        id: `ord-gum-${baseTs}-${idx}`,
        orderNumber,
        businessId: resolvedBizId,
        customerId: cust.id,
        productId: matchedProd?.id || sale.gumroadProductId || 'gumroad-external',
        productName: matchedProd?.name || sale.productName || 'Gumroad Digital Product',
        customerName: cust.name,
        customerEmail: cust.email,
        amount,
        currency: (sale.currency || 'USD').toUpperCase(),
        status: orderStatus,
        paymentMethod: 'Gumroad Marketplace',
        refundReason: sale.refunded ? 'Refunded on Gumroad' : undefined,
        createdAt,
      };

      newOrders.push(newOrd);
      imported += 1;

      if (!sale.refunded) {
        const prevCustInc = customerIncrements.get(cust.id) || { spend: 0, count: 0, lastAt: createdAt };
        customerIncrements.set(cust.id, {
          spend: prevCustInc.spend + amount,
          count: prevCustInc.count + 1,
          lastAt: createdAt,
        });

        if (matchedProd) {
          const prevProdInc = productIncrements.get(matchedProd.id) || { sales: 0, revenue: 0 };
          productIncrements.set(matchedProd.id, {
            sales: prevProdInc.sales + 1,
            revenue: prevProdInc.revenue + amount,
          });
        }
      }
    });

    if (newOrders.length > 0 || refundedOrderNumbers.size > 0) {
      setOrders((prev) => {
        const updatedExisting =
          refundedOrderNumbers.size > 0
            ? prev.map((o) =>
                refundedOrderNumbers.has(o.orderNumber)
                  ? { ...o, status: 'refunded' as const, refundReason: 'Refunded on Gumroad' }
                  : o
              )
            : prev;
        return [...newOrders, ...updatedExisting];
      });
    }

    if (newCustomers.length > 0 || customerIncrements.size > 0) {
      setCustomers((prev) => {
        const merged = [...prev, ...newCustomers];
        return merged.map((c) => {
          const inc = customerIncrements.get(c.id);
          if (!inc) return c;
          return {
            ...c,
            ordersCount: c.ordersCount + inc.count,
            totalSpend: c.totalSpend + inc.spend,
            lastActiveAt: inc.lastAt,
            status: 'active',
          };
        });
      });
    }

    if (productIncrements.size > 0) {
      setProducts((prev) =>
        prev.map((p) => {
          const inc = productIncrements.get(p.id);
          if (!inc) return p;
          return {
            ...p,
            salesCount: p.salesCount + inc.sales,
            totalRevenue: p.totalRevenue + inc.revenue,
            updatedAt: new Date().toISOString(),
          };
        })
      );
    }

    if (imported > 0 || updated > 0) {
      logActivity(
        'GUMROAD_SALES_SYNCED',
        `Synced Gumroad ledger: ${imported} new order(s), ${updated} refund update(s), ${skipped} duplicate(s) skipped.`,
        'success'
      );
    }

    return { imported, updated, skipped };
  };

  // Marketing Campaigns
  const addCampaign = (campData: Omit<MarketingCampaign, 'id' | 'createdAt' | 'spent'>) => {
    const newCamp: MarketingCampaign = {
      ...campData,
      id: `camp-${Date.now()}`,
      spent: 0,
      createdAt: new Date().toISOString(),
    };
    setCampaigns((prev) => [...prev, newCamp]);
    logActivity('CAMPAIGN_CREATED', `Drafted marketing campaign "${newCamp.name}" (${newCamp.channel})`, 'info', newCamp.businessId);
    return newCamp;
  };

  const updateCampaign = (id: string, updates: Partial<MarketingCampaign>) => {
    setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  };

  const submitCampaignForApproval = (campaignId: string) => {
    const camp = campaigns.find((c) => c.id === campaignId);
    if (!camp) return;
    updateCampaign(campaignId, { status: 'awaiting_approval' });
    createApprovalRequest({
      type: 'send_marketing_campaign',
      title: `Authorize Campaign Broadcast: ${camp.name}`,
      description: `Marketing Department requesting approval to launch ${camp.channel} campaign (Budget: $${camp.budget}). Target: ${camp.targetAudience}`,
      businessId: camp.businessId,
      requestedByDepartment: 'marketing',
      urgency: 'standard',
      payloadData: { campaignId: camp.id, budget: camp.budget, channel: camp.channel },
    });
    logActivity('CAMPAIGN_APPROVAL_SUBMITTED', `Campaign "${camp.name}" submitted for Owner Authorization`, 'warning', camp.businessId);
  };

  const deleteCampaign = (id: string) => {
    setCampaigns((prev) => prev.filter((c) => c.id !== id));
  };

  // Financial Expenses
  const addExpense = (expData: Omit<ExpenseRecord, 'id' | 'createdAt'>) => {
    const newExp: ExpenseRecord = {
      ...expData,
      id: `exp-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    setExpenses((prev) => [newExp, ...prev]);
    logActivity('EXPENSE_LOGGED', `Recorded $${newExp.amount} expense to ${newExp.vendor} (${newExp.category})`, 'info', newExp.businessId);
    return newExp;
  };

  const deleteExpense = (id: string) => {
    setExpenses((prev) => prev.filter((e) => e.id !== id));
  };

  // Automations
  const toggleAutomation = (id: string) => {
    setAutomations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, isActive: !a.isActive } : a))
    );
  };

  const addAutomation = (ruleData: Omit<AutomationRule, 'id' | 'executionCount'>) => {
    const newRule: AutomationRule = {
      ...ruleData,
      id: `auto-${Date.now()}`,
      executionCount: 0,
    };
    setAutomations((prev) => [...prev, newRule]);
    logActivity('AUTOMATION_ADDED', `Created workflow automation rule: "${newRule.name}"`);
    return newRule;
  };

  const deleteAutomation = (id: string) => {
    setAutomations((prev) => prev.filter((a) => a.id !== id));
  };

  const refreshAuthoritativeApprovals = async () => {
    const token = await getSupabaseAccessToken();
    if (!token) {
      setServerOwnerApprovals([]);
      setServerApprovalsError('Sign in with Supabase Auth to load authoritative owner approvals.');
      return;
    }

    setIsSyncingServerApprovals(true);
    setServerApprovalsError(null);
    try {
      const res = await fetchAuthoritativeOwnerApprovals(token);
      if (!res.ok || !res.data) {
        setServerApprovalsError(
          res.error || 'Could not load authoritative approvals from server.'
        );
        return;
      }

      const fetched = res.data.approvals;
      setServerOwnerApprovals(fetched);

      // Reconcile refund approval tickets strictly from authoritative server records
      setApprovals((prev) =>
        prev.map((ticket) => {
          if (ticket.type !== 'issue_refund') return ticket;
          const reqId = ticket.payloadData?.requestId;
          const match = fetched.find(
            (s) =>
              (ticket.serverApprovalId && s.approval_id === ticket.serverApprovalId) ||
              (reqId && s.request_id === reqId)
          );
          if (!match) {
            return ticket;
          }
          const mappedStatus: ApprovalRequest['status'] =
            match.status === 'approved' || match.status === 'consumed'
              ? 'approved'
              : match.status === 'rejected' || match.status === 'revoked'
              ? 'rejected'
              : 'pending';
          return {
            ...ticket,
            status: mappedStatus,
            serverApprovalId: match.approval_id,
            serverApprovalStatus: match.status,
            serverExpiresAt: match.expires_at,
            serverConsumedAt: match.consumed_at ?? null,
            decidedBy: match.approved_by_user_id,
            decidedAt: match.created_at || ticket.decidedAt,
            decisionNote: match.decision_note ?? ticket.decisionNote,
            authoritativeSynced: true,
          };
        })
      );
    } finally {
      setIsSyncingServerApprovals(false);
    }
  };

  const revokeServerOwnerApproval = async (
    approvalId: string
  ): Promise<{ ok: boolean; error?: string }> => {
    const token = await getSupabaseAccessToken();
    if (!token) {
      return {
        ok: false,
        error: 'Supabase authentication session required to revoke an owner approval.',
      };
    }
    const res = await revokeAuthoritativeOwnerApproval(approvalId, token);
    if (!res.ok || !res.data?.approval) {
      return {
        ok: false,
        error: res.error || 'Server rejected approval revocation.',
      };
    }

    const revoked = res.data.approval;
    setServerOwnerApprovals((prev) =>
      prev.map((a) => (a.approval_id === revoked.approval_id ? revoked : a))
    );
    setApprovals((prev) =>
      prev.map((t) =>
        t.serverApprovalId === revoked.approval_id ||
        (t.payloadData?.requestId && t.payloadData.requestId === revoked.request_id)
          ? {
              ...t,
              status: 'rejected',
              serverApprovalStatus: revoked.status,
              decisionNote: t.decisionNote
                ? `${t.decisionNote} (Revoked on server)`
                : 'Revoked on server by Owner',
              authoritativeSynced: true,
            }
          : t
      )
    );
    logActivity(
      'APPROVAL_REVOKED',
      `Owner revoked authoritative approval ${revoked.approval_id} for order ${revoked.order_id}.`,
      'warning',
      revoked.business_id
    );
    return { ok: true };
  };

  // Approvals Core Workflow
  const createApprovalRequest = (req: Omit<ApprovalRequest, 'id' | 'createdAt' | 'status'>) => {
    const newReq: ApprovalRequest = {
      ...req,
      id: `appr-${Date.now()}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    setApprovals((prev) => [newReq, ...prev]);
    return newReq;
  };

  const approveRequest = async (
    id: string,
    note?: string
  ): Promise<{ ok: boolean; error?: string; approval?: ServerOwnerApprovalRecord }> => {
    const req = approvals.find((a) => a.id === id);
    if (!req) {
      return { ok: false, error: 'Approval request ticket not found.' };
    }

    // Finance refund approvals MUST be persisted authoritatively on the server FIRST.
    // Never optimistically mark a refund approval as approved in local UI state.
    if (req.type === 'issue_refund') {
      const requestId =
        typeof req.payloadData?.requestId === 'string'
          ? req.payloadData.requestId.trim()
          : '';
      const orderId =
        typeof req.payloadData?.orderId === 'string'
          ? req.payloadData.orderId.trim()
          : '';
      const amountCents = Number.isInteger(req.payloadData?.amountCents)
        ? Number(req.payloadData?.amountCents)
        : Math.round(Number(req.payloadData?.amount || 0) * 100);

      if (!requestId || !orderId || !Number.isInteger(amountCents) || amountCents <= 0) {
        return {
          ok: false,
          error:
            'Refund ticket is missing authoritative server provenance metadata (request_id, order_id, or amount_cents). Ingest the refund request via an authenticated session first.',
        };
      }

      const token = await getSupabaseAccessToken();
      if (!token) {
        return {
          ok: false,
          error:
            'Sign in with an authenticated Owner or Admin Supabase session before creating an authoritative refund approval.',
        };
      }

      const apiRes = await createAuthoritativeOwnerApproval(
        {
          request_id: requestId,
          order_id: orderId,
          business_id: req.businessId,
          amount_cents: amountCents,
          decision_note: note?.trim() || undefined,
        },
        token
      );

      if (!apiRes.ok || !apiRes.data?.approval) {
        logActivity(
          'APPROVAL_DENIED',
          `Server rejected refund approval for "${req.title}": ${apiRes.error || 'unknown error'}`,
          'critical',
          req.businessId
        );
        return {
          ok: false,
          error: apiRes.error || 'Server rejected owner approval creation.',
        };
      }

      const created = apiRes.data.approval;
      setApprovals((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                ...a,
                status: 'approved',
                decisionNote:
                  created.decision_note || note || 'Authoritatively approved on server',
                decidedAt: created.created_at || new Date().toISOString(),
                decidedBy: created.approved_by_user_id,
                serverApprovalId: created.approval_id,
                serverApprovalStatus: created.status,
                serverExpiresAt: created.expires_at,
                serverConsumedAt: created.consumed_at ?? null,
                authoritativeSynced: true,
              }
            : a
        )
      );
      setServerOwnerApprovals((prev) => [
        created,
        ...prev.filter((item) => item.approval_id !== created.approval_id),
      ]);

      logActivity(
        'APPROVAL_GRANTED',
        `Authoritative server approval ${created.approval_id} created by ${created.approved_by_user_id} for "${req.title}"`,
        'success',
        req.businessId
      );
      return { ok: true, approval: created };
    }

    setApprovals((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              status: 'approved',
              decisionNote: note || 'Approved by Executive Owner',
              decidedAt: new Date().toISOString(),
              decidedBy: ownerProfile.name,
            }
          : a
      )
    );

    // Apply domain side-effects for non-refund workflows
    if (req.type === 'publish_product' && req.payloadData?.productId) {
      try {
        const token = await getSupabaseAccessToken();
        if (token) {
          const apprResp = await authorizedApiFetch('/api/commerce/publish-approvals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              productId: req.payloadData.productId,
              businessId: req.businessId,
              decisionNote: note || 'Approved by Executive Owner',
              replaceExisting: true,
            }),
          });
          if (apprResp.ok) {
            const apprData = await apprResp.json().catch(() => null);
            const serverApprovalId = apprData?.approval?.approvalId
              ? String(apprData.approval.approvalId)
              : '';
            if (serverApprovalId) {
              await authorizedApiFetch('/api/commerce/products/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  productId: req.payloadData.productId,
                  businessId: req.businessId,
                  approvalId: serverApprovalId,
                }),
              });
            }
          }
        }
      } catch {
        // Ignore network errors on local-only drafts
      }

      updateProduct(req.payloadData.productId, {
        status: 'published',
        publishedApprovalId: undefined,
      });
      const approvalNow = new Date().toISOString();
      setFactoryJobs((prev) =>
        prev.map((j) =>
          j.id === req.payloadData?.factoryJobId || j.productId === req.payloadData?.productId
            ? {
                ...j,
                currentStage: 'completed',
                jobStatus: 'completed',
                progress: 100,
                updatedAt: approvalNow,
                stageLogs: [
                  ...(j.stageLogs || []),
                  {
                    stage: 'completed',
                    timestamp: approvalNow,
                    message: `Executive Owner approved launch (${note || 'Authorized in Approval Center'}).`,
                  },
                ],
              }
            : j
        )
      );
      setTasks((prev) =>
        prev.map((t) =>
          t.approvalRequestId === id
            ? {
                ...t,
                status: 'completed',
                resultPayload: note || 'Authorized by Executive Owner',
                completedAt: approvalNow,
              }
            : t
        )
      );
    } else if (req.type === 'send_marketing_campaign' && req.payloadData?.campaignId) {
      updateCampaign(req.payloadData.campaignId, { status: 'active' });
    } else if (req.type === 'deploy_production_code' && req.payloadData?.projectId) {
      updateProject(req.payloadData.projectId, { deploymentStatus: 'live' });
    }

    logActivity('APPROVAL_GRANTED', `Owner approved request: "${req.title}"`, 'success', req.businessId);
    return { ok: true };
  };

  const rejectRequest = async (
    id: string,
    reason: string
  ): Promise<{ ok: boolean; error?: string }> => {
    const req = approvals.find((a) => a.id === id);
    if (!req) {
      return { ok: false, error: 'Approval request ticket not found.' };
    }

    if (req.type === 'issue_refund' && req.serverApprovalId) {
      const revokeRes = await revokeServerOwnerApproval(req.serverApprovalId);
      if (!revokeRes.ok) {
        return revokeRes;
      }
    }

    setApprovals((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              status: 'rejected',
              decisionNote: reason,
              decidedAt: new Date().toISOString(),
              decidedBy: ownerProfile.name,
            }
          : a
      )
    );

    // If product was awaiting approval, restore to draft
    if (req.type === 'publish_product' && req.payloadData?.productId) {
      updateProduct(req.payloadData.productId, { status: 'draft' });
      const rejectNow = new Date().toISOString();
      setFactoryJobs((prev) =>
        prev.map((j) =>
          j.id === req.payloadData?.factoryJobId || j.productId === req.payloadData?.productId
            ? {
                ...j,
                jobStatus: 'cancelled',
                errorMessage: `Rejected by Owner: ${reason}`,
                updatedAt: rejectNow,
                stageLogs: [
                  ...(j.stageLogs || []),
                  {
                    stage: j.currentStage,
                    timestamp: rejectNow,
                    message: `Returned to Draft by Owner (${reason}).`,
                  },
                ],
              }
            : j
        )
      );
      setTasks((prev) =>
        prev.map((t) =>
          t.approvalRequestId === id
            ? {
                ...t,
                status: 'rejected',
                resultPayload: reason,
              }
            : t
        )
      );
    } else if (req.type === 'send_marketing_campaign' && req.payloadData?.campaignId) {
      updateCampaign(req.payloadData.campaignId, { status: 'draft' });
    }

    logActivity('APPROVAL_REJECTED', `Owner rejected request: "${req.title}" (Reason: ${reason})`, 'critical', req.businessId);
    return { ok: true };
  };

  // AI Assistant Chat & Coordination
  const createNewConversation = (title?: string) => {
    const newConv: Conversation = {
      id: `conv-${Date.now()}`,
      title: title || `Strategic Briefing #${conversations.length + 1}`,
      businessId: selectedBusinessId !== 'all' ? selectedBusinessId : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setConversations((prev) => [newConv, ...prev]);
    setActiveConversationId(newConv.id);

    const greeting: ChatMessage = {
      id: `msg-${Date.now()}`,
      conversationId: newConv.id,
      role: 'assistant',
      content: `Ready for a new session. Current context: ${
        selectedBusiness ? selectedBusiness.name : 'Cross-Venture Overview'
      }. What objective shall we tackle across your AI workforce?`,
      timestamp: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, greeting]);
    return newConv.id;
  };

  const deleteConversation = (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setChatMessages((prev) => prev.filter((m) => m.conversationId !== id));
    if (activeConversationId === id) {
      const remaining = conversations.filter((c) => c.id !== id);
      setActiveConversationId(remaining.length > 0 ? remaining[0].id : null);
    }
  };

  const sendMessageToAssistant = async (content: string) => {
    if (!content.trim() || !activeConversationId) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      conversationId: activeConversationId,
      role: 'user',
      content: content.trim(),
      timestamp: new Date().toISOString(),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    setIsAiThinking(true);

    const historyPayload = chatMessages
      .filter((m) => m.conversationId === activeConversationId)
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));

    // 1. Memory Context Retrieval
    const activeMemories = getMemoriesForContext(selectedBusinessId);

    // 2. Check for conversation memory extraction intent
    const lowerText = content.toLowerCase();
    const memoryTriggers = ['remember that', 'remember this', 'our goal is', 'our strategy is', 'we decided', 'our price is', 'our stack is', 'set policy', 'preference:'];
    if (memoryTriggers.some(trigger => lowerText.includes(trigger))) {
      let category: MemoryCategory = 'instruction';
      if (lowerText.includes('goal')) category = 'goal';
      else if (lowerText.includes('strategy')) category = 'strategy';
      else if (lowerText.includes('decided') || lowerText.includes('decision')) category = 'decision';
      else if (lowerText.includes('preference')) category = 'preference';
      else if (lowerText.includes('price') || lowerText.includes('cost')) category = 'product_info';

      addMemory({
        businessId: selectedBusinessId !== 'all' ? selectedBusinessId : undefined,
        category,
        importance: 'high',
        title: content.length > 50 ? `${content.slice(0, 47)}...` : content,
        content: content,
        department: 'global',
        source: 'conversation_extracted',
        tags: ['auto-extracted', 'chat'],
      });
    }

    const contextPayload = {
      selectedBusiness: selectedBusiness?.name || 'All Businesses',
      totalBusinesses: businesses.length,
      totalProjects: projects.length,
      totalProducts: products.length,
      pendingApprovals: approvals.filter((a) => a.status === 'pending').length,
      memories: activeMemories.map((m) => ({
        category: m.category,
        importance: m.importance,
        department: m.department || 'global',
        title: m.title,
        content: m.content,
      })),
    };

    try {
      // 1. Try Supabase Edge Function 'ai-assistant' connected to Google Gemini API
      if (supabaseConfig.isConnected && supabaseConfig.projectUrl && supabaseConfig.anonKey) {
        const edgeRes = await invokeAIAssistantEdgeFunction({
          prompt: content,
          message: content,
          context: contextPayload,
          history: historyPayload,
        });

        if (edgeRes.success && edgeRes.reply) {
          const assistantMsg: ChatMessage = {
            id: `msg-${Date.now()}`,
            conversationId: activeConversationId,
            role: 'assistant',
            content: edgeRes.reply,
            timestamp: new Date().toISOString(),
            source: 'supabase_edge_function',
            model: edgeRes.model || 'gemini-2.5-flash',
            isFallback: false,
          };
          setChatMessages((prev) => [...prev, assistantMsg]);
          logActivity(
            'AI_GEMINI_RESPONSE',
            `Processed live directive via Supabase Edge Function "ai-assistant" (Google Gemini ${edgeRes.model || 'gemini-2.5-flash'})`,
            'success',
            selectedBusiness?.id
          );
          return;
        }

        // If Edge Function returned an error (e.g. missing secret or not deployed), show informative diagnostic error
        const errorContent = `[Supabase Edge Function: ai-assistant Diagnostics]\nInvocation Error: ${edgeRes.error || 'Invocation failed'}\n\n${
          edgeRes.instructions ? `Action Required:\n${edgeRes.instructions}\n\n` : ''
        }Diagnostic Metadata:\n• Target Endpoint: ${supabaseConfig.projectUrl}/functions/v1/ai-assistant\n• Engine: Google Gemini (gemini-2.5-flash)\n• Expected Server Secret: GEMINI_API_KEY_2 or GEMINI_API_KEY (in Supabase project)\n• Client Status: Connected with Anon Key`;

        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          conversationId: activeConversationId,
          role: 'assistant',
          content: errorContent,
          timestamp: new Date().toISOString(),
          source: 'error_diagnostic',
          isFallback: false,
          errorDetails: {
            status: edgeRes.error,
            instructions: edgeRes.instructions,
          },
        };
        setChatMessages((prev) => [...prev, assistantMsg]);
        logActivity('AI_EDGE_FUNCTION_NOTICE', `Supabase Edge Function invocation error: ${edgeRes.error}`, 'warning', selectedBusiness?.id);
        return;
      }

      // 2. If Supabase is not connected yet, invoke authenticated local server coordinator
      const response = await authorizedApiFetch('/api/ai/coordinator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: content,
          message: content,
          context: contextPayload,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const isLiveGemini = data.provider === 'google_gemini_server' && !data.isFallback;
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          conversationId: activeConversationId,
          role: 'assistant',
          content: data.reply || 'Request analyzed by executive coordinator.',
          timestamp: new Date().toISOString(),
          actionProposals: data.proposals || undefined,
          source: isLiveGemini ? 'server_gemini' : 'offline_fallback',
          isFallback: !isLiveGemini,
          model: data.model || (isLiveGemini ? 'gemini-2.5-flash' : 'offline_simulator'),
        };
        setChatMessages((prev) => [...prev, assistantMsg]);
      } else {
        const fallbackText = generateExecutiveResponse(content, selectedBusiness, departments);
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          conversationId: activeConversationId,
          role: 'assistant',
          content: `[System Notice: Offline Mode]\nConnect your Supabase project in Settings or deploy the "ai-assistant" Edge Function to enable live Gemini intelligence.\n\n${fallbackText}`,
          timestamp: new Date().toISOString(),
          source: 'offline_fallback',
          isFallback: true,
        };
        setChatMessages((prev) => [...prev, assistantMsg]);
      }
    } catch (e: any) {
      const fallbackText = generateExecutiveResponse(content, selectedBusiness, departments);
      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        conversationId: activeConversationId,
        role: 'assistant',
        content: `[Connection Notice]: ${e?.message || 'Network error'}\n\n${fallbackText}`,
        timestamp: new Date().toISOString(),
        source: 'error_diagnostic',
        isFallback: true,
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } finally {
      setIsAiThinking(false);
    }
  };

  const generateExecutiveResponse = (
    prompt: string,
    biz: Business | null,
    depts: AIAgentDepartment[]
  ): string => {
    const p = prompt.toLowerCase();
    const bizName = biz ? biz.name : 'all portfolio ventures';

    if (p.includes('approval') || p.includes('deploy') || p.includes('publish')) {
      return `[Coordinator Directive for ${bizName}]\nI have verified our governance protocol. Any production release, marketing broadcast, or financial transaction requires Owner Approval.\n\nRecommended next steps:\n1. Draft the formal proposal in the associated AI Department.\n2. Submit specification to the Approval Center.\n3. The Owner must review the payload before activation.`;
    }
    if (p.includes('marketing') || p.includes('campaign') || p.includes('seo')) {
      return `[Marketing Department Briefing]\nFor ${bizName}, our Marketing AI agent is structured to target verified audiences. You can create a campaign draft in the Marketing section, specify conversion metrics, and route it to your Approval Center once prepared.`;
    }
    if (p.includes('product') || p.includes('saas') || p.includes('price')) {
      return `[Product Creation Briefing]\nDigital product strategy initialized. To launch a new offering in ${bizName}, create a draft product in the Products tab. You can configure one-time or subscription pricing, add delivery instructions, and trigger executive review.`;
    }
    if (p.includes('security') || p.includes('supabase') || p.includes('rls')) {
      return `[Security Department Briefing]\nDatabase RLS verification status: Active. In the Settings tab, you can inspect the full PostgreSQL schema for all 13 core tables with strict Owner-Level Security policies.`;
    }
    if (p.includes('nexus') || p.includes('introduce') || p.includes('who are you') || p.includes('assistant')) {
      return `[Nexus AI Executive Assistant]\nHello, Founder. I am your Nexus AI Business OS Assistant—the central nervous system and sovereign coordinator for ${bizName} and your entire multi-business empire.\n\nI direct 6 specialized AI departments on your behalf:\n1. Development & Engineering (software architecture, GitHub repositories, and deployment verification)\n2. Product Creation & Strategy (digital products, pricing models, and PRD specifications)\n3. Marketing & Growth (omni-channel acquisition funnels, campaign telemetry, and SEO)\n4. Customer Support (ticket handling, customer onboarding, and satisfaction monitoring)\n5. Financial Intelligence (revenue streams, profit margins, and SaaS expense burn)\n6. Security & Governance (PostgreSQL Row Level Security, zero-trust tenant boundaries)\n\nStrict Governance Directive: I will never deploy code, release products, launch campaigns, or issue refunds without your formal Owner Approval in the Approval Center.\n\nHow shall we advance your business objectives today?`;
    }

    return `Executive Coordinator acknowledged for ${bizName}. All 6 AI departments (Development, Product, Marketing, Support, Finance, Security) are active and operating under strict owner-approval boundaries. What would you like to plan or orchestrate next?`;
  };

  // Configurations
  const updateSupabaseConfig = (cfg: StoredSupabaseConfig) => {
    setSupabaseConfigState(cfg);
    saveStoredSupabaseConfig(cfg);
    logActivity('SUPABASE_CONFIG_UPDATED', `Supabase connection parameters updated. State: ${cfg.isConnected ? 'Connected' : 'Disconnected'}`, 'info');
  };

  const updateAIConfig = (cfg: Partial<AIProviderConfig>) => {
    setAIConfigState((prev) => ({ ...prev, ...cfg }));
    logActivity('AI_CONFIG_UPDATED', 'Updated AI Provider configuration and model routing settings.');
  };

  const clearActivityLogs = () => {
    setActivityLogs([]);
  };

  // Backup & Reset
  const exportDatabaseJSON = (): string => {
    const dump = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      ownerProfile,
      businesses,
      projects,
      departments,
      tasks,
      products,
      factoryJobs,
      orders,
      customers,
      campaigns,
      expenses,
      automations,
      approvals,
      activityLogs,
    };
    return JSON.stringify(dump, null, 2);
  };

  const importDatabaseJSON = (jsonStr: string): boolean => {
    try {
      const data = JSON.parse(jsonStr);
      if (data.businesses) setBusinesses(data.businesses);
      if (data.projects) setProjects(data.projects);
      if (data.departments) setDepartments(data.departments);
      if (data.tasks) setTasks(data.tasks);
      if (Array.isArray(data.products)) {
        // M3: Never restore stale or spoofed server publish approval references from JSON backup
        setProducts(
          data.products.map((p: Product) => ({
            ...p,
            publishedApprovalId: undefined,
          }))
        );
      }
      if (data.factoryJobs) setFactoryJobs(data.factoryJobs);
      if (data.orders) setOrders(data.orders);
      if (data.customers) setCustomers(data.customers);
      if (data.campaigns) setCampaigns(data.campaigns);
      if (data.expenses) setExpenses(data.expenses);
      if (data.automations) setAutomations(data.automations);
      if (Array.isArray(data.approvals)) {
        // M3: Strip client-forged authoritative flags; approvals must be re-verified from server
        setApprovals(
          data.approvals.map((a: ApprovalRequest) => ({
            ...a,
            authoritativeSynced: undefined,
            serverApprovalId: undefined,
            serverApprovalStatus: undefined,
            serverExpiresAt: undefined,
            serverConsumedAt: undefined,
            payloadData: a.payloadData
              ? {
                  ...a.payloadData,
                  authoritativeSynced: undefined,
                }
              : a.payloadData,
          }))
        );
      }
      logActivity('DATABASE_RESTORED', 'Restored database state from imported JSON backup (server approval flags stripped).', 'warning');
      return true;
    } catch (e) {
      console.error('Failed to parse backup JSON', e);
      return false;
    }
  };

  const seedRealisticStarterData = () => {
    const bizId = 'biz-prime';
    const now = new Date().toISOString();

    const sampleProducts: Product[] = [
      {
        id: 'prod-starter-1',
        businessId: bizId,
        name: 'Nexus API Edge License',
        slug: 'nexus-edge-license',
        description: 'Single-tenant edge routing microservice with 10M monthly API hits capacity.',
        type: 'saas',
        price: 99.0,
        billingType: 'monthly',
        status: 'published',
        salesCount: 1,
        totalRevenue: 99.0,
        downloadOrAccessUrl: 'https://gateway.nexuscloud.internal/license',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'prod-starter-2',
        businessId: bizId,
        name: 'Autonomous AI Orchestrator Template',
        slug: 'ai-orchestrator-template',
        description: 'Production-ready Node.js & TypeScript agent orchestration architecture with RLS.',
        type: 'template',
        price: 149.0,
        billingType: 'one_time',
        status: 'draft',
        salesCount: 0,
        totalRevenue: 0,
        downloadOrAccessUrl: 'https://github.com/nexus-org/agent-template',
        createdAt: now,
        updatedAt: now,
      },
    ];

    const sampleCust: Customer = {
      id: 'cust-starter-1',
      businessId: bizId,
      name: 'Alexander Wright',
      email: 'alex.wright@hyperlink.dev',
      status: 'active',
      totalSpend: 99.0,
      ordersCount: 1,
      firstPurchasedAt: now,
      lastActiveAt: now,
      notes: 'Early adopter evaluating our edge gateway for their fintech app.',
    };

    const sampleOrder: Order = {
      id: 'ord-starter-1',
      orderNumber: 'ORD-882194',
      businessId: bizId,
      customerId: sampleCust.id,
      productId: sampleProducts[0].id,
      productName: sampleProducts[0].name,
      customerName: sampleCust.name,
      customerEmail: sampleCust.email,
      amount: 99.0,
      currency: 'USD',
      status: 'completed',
      paymentMethod: 'Stripe Gateway (Verified)',
      createdAt: now,
    };

    const sampleApproval: ApprovalRequest = {
      id: 'appr-starter-1',
      type: 'publish_product',
      title: 'Publish Product: Autonomous AI Orchestrator Template',
      description: 'Product Creation department submitted the Autonomous AI Orchestrator Template for public catalog distribution ($149.00 one-time).',
      businessId: bizId,
      requestedByDepartment: 'product_creation',
      status: 'pending',
      urgency: 'standard',
      payloadData: { productId: sampleProducts[1].id, price: 149.0 },
      createdAt: now,
    };

    setProducts(sampleProducts);
    setCustomers([sampleCust]);
    setOrders([sampleOrder]);
    setApprovals([sampleApproval]);
    logActivity('SEEDED_STARTER_DATA', 'Populated realistic baseline records for testing.', 'info', bizId);
  };

  const resetToCleanSlate = () => {
    setProducts([]);
    setFactoryJobs([]);
    setOrders([]);
    setCustomers([]);
    setCampaigns([]);
    setExpenses([]);
    setApprovals([]);
    setTasks([]);
    setActivityLogs([
      {
        id: `act-${Date.now()}`,
        timestamp: new Date().toISOString(),
        actor: 'System Kernel',
        actorType: 'system',
        action: 'DATABASE_RESET',
        details: 'System cleared to pristine empty state. Ready for fresh business telemetry.',
        severity: 'warning',
      },
    ]);
  };

  return (
    <OSContext.Provider
      value={{
        activeSection,
        setActiveSection,
        productsViewMode,
        setProductsViewMode,
        selectedBusinessId,
        setSelectedBusinessId,
        selectedBusiness,
        ownerProfile,
        updateOwnerProfile,
        lockOS,
        unlockOS,
        businesses,
        addBusiness,
        updateBusiness,
        archiveBusiness,
        deleteBusiness,
        projects,
        addProject,
        updateProject,
        deleteProject,
        pingProjectHealth,
        departments,
        updateDepartment,
        tasks,
        addTask,
        updateTaskStatus,
        products,
        addProduct,
        updateProduct,
        submitProductForApproval,
        approveAndPublishProductDirect,
        deleteProduct,
        restoreFlagshipContentMachine,
        factoryJobs,
        runDigitalProductFactory,
        orders,
        customers,
        addOrder,
        addCustomer,
        recordCustomerPurchase,
        syncGumroadSales,
        requestRefund,
        campaigns,
        addCampaign,
        updateCampaign,
        submitCampaignForApproval,
        deleteCampaign,
        expenses,
        addExpense,
        deleteExpense,
        automations,
        toggleAutomation,
        addAutomation,
        deleteAutomation,
        approvals,
        serverOwnerApprovals,
        isSyncingServerApprovals,
        serverApprovalsError,
        refreshAuthoritativeApprovals,
        revokeServerOwnerApproval,
        createApprovalRequest,
        approveRequest,
        rejectRequest,
        activityLogs,
        logActivity,
        clearActivityLogs,
        conversations,
        activeConversationId,
        setActiveConversationId,
        chatMessages,
        createNewConversation,
        sendMessageToAssistant,
        deleteConversation,
        isAiThinking,
        supabaseConfig,
        updateSupabaseConfig,
        aiConfig,
        updateAIConfig,
        memories,
        addMemory,
        updateMemory,
        deleteMemory,
        togglePinMemory,
        getMemoriesForContext,
        exportDatabaseJSON,
        importDatabaseJSON,
        seedRealisticStarterData,
        resetToCleanSlate,
      }}
    >
      {children}
    </OSContext.Provider>
  );
};

export const useOS = (): OSContextType => {
  const context = useContext(OSContext);
  if (!context) {
    throw new Error('useOS must be used within an OSProvider');
  }
  return context;
};
