export type BusinessStatus = 'active' | 'planning' | 'paused' | 'archived';

export interface Business {
  id: string;
  name: string;
  slug: string;
  description: string;
  industry: string;
  currency: string;
  targetMarket?: string;
  websiteUrl?: string;
  status: BusinessStatus;
  createdAt: string;
  updatedAt: string;
}

export type DeploymentStatus = 'live' | 'staging' | 'in_progress' | 'degraded' | 'down' | 'draft';

export interface Project {
  id: string;
  businessId: string;
  name: string;
  description: string;
  websiteUrl?: string;
  githubUrl?: string;
  techStack: string[];
  deploymentStatus: DeploymentStatus;
  notes?: string;
  lastCheckedDate?: string;
  healthPingStatus?: 'healthy' | 'warning' | 'down' | 'unchecked';
  createdAt: string;
  updatedAt: string;
}

export type AIDepartmentType =
  | 'development'
  | 'product_creation'
  | 'marketing'
  | 'customer_support'
  | 'finance'
  | 'security';

export type AgentAutonomyLevel = 'strict_approval' | 'semi_autonomous' | 'read_only';

export interface AIAgentDepartment {
  id: string;
  type: AIDepartmentType;
  name: string;
  description: string;
  status: 'active' | 'idle' | 'paused';
  systemInstructions: string;
  autonomyLevel: AgentAutonomyLevel;
  activeTasksCount: number;
  completedTasksCount: number;
  permissions: {
    canDeployCode: boolean;
    canPublishProducts: boolean;
    canSendMarketing: boolean;
    canIssueRefunds: boolean;
    canRecordExpenses: boolean;
    canModifySecurity: boolean;
  };
  lastActiveAt?: string;
}

export type TaskStatus = 'pending' | 'in_progress' | 'awaiting_approval' | 'completed' | 'rejected' | 'failed';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface AgentTask {
  id: string;
  departmentId: AIDepartmentType;
  businessId?: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedAgent: string;
  approvalRequestId?: string;
  resultPayload?: string;
  createdAt: string;
  completedAt?: string;
}

export type ApprovalType =
  | 'publish_product'
  | 'deploy_production_code'
  | 'send_marketing_campaign'
  | 'issue_refund'
  | 'make_purchase'
  | 'change_security_settings';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  title: string;
  description: string;
  businessId: string;
  requestedByDepartment: AIDepartmentType;
  status: ApprovalStatus;
  urgency: 'routine' | 'standard' | 'high' | 'critical';
  payloadData?: Record<string, any>;
  decisionNote?: string;
  decidedAt?: string;
  decidedBy?: string;
  createdAt: string;
  serverApprovalId?: string;
  serverApprovalStatus?: 'pending' | 'approved' | 'rejected' | 'revoked' | 'consumed';
  serverExpiresAt?: string;
  serverConsumedAt?: string | null;
  authoritativeSynced?: boolean;
}

export type ProductType = 'saas' | 'digital_download' | 'course' | 'api_service' | 'template' | 'newsletter';
export type ProductStatus = 'draft' | 'awaiting_approval' | 'published' | 'archived';

export interface Product {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  description: string;
  type: ProductType;
  price: number;
  billingType: 'one_time' | 'monthly' | 'yearly' | 'free';
  status: ProductStatus;
  inventoryOrLicenseCount?: number;
  salesCount: number;
  totalRevenue: number;
  downloadOrAccessUrl?: string;
  deliverableContent?: string;
  deliverableFormat?: 'pdf_guide' | 'template_pack' | 'prompt_bundle' | 'saas_license';
  coverImageUrl?: string;
  pdfStoragePath?: string;
  gumroadProductId?: string;
  gumroadUrl?: string;
  publishedApprovalId?: string;
  factoryMetadata?: Record<string, any>;
  stripePriceId?: string;
  createdAt: string;
  updatedAt: string;
}

export type FactoryPipelineStage =
  | 'queued'
  | 'researching'
  | 'writing_content'
  | 'generating_cover'
  | 'building_pdf'
  | 'uploading_assets'
  | 'drafting_marketing'
  | 'awaiting_approval'
  | 'completed'
  | 'failed';

export type FactoryJobStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FactoryJob {
  id: string;
  ownerId?: string;
  businessId: string;
  productId?: string | null;
  currentStage: FactoryPipelineStage;
  jobStatus: FactoryJobStatus;
  progress: number;
  errorMessage?: string | null;
  stageLogs?: Array<{ stage: string; timestamp: string; message: string }>;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus = 'completed' | 'pending' | 'refunded' | 'disputed' | 'cancelled';

export interface Order {
  id: string;
  orderNumber: string;
  businessId: string;
  customerId: string;
  productId: string;
  productName: string;
  customerName: string;
  customerEmail: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  paymentMethod: string;
  refundReason?: string;
  createdAt: string;
}

export interface Customer {
  id: string;
  businessId: string;
  name: string;
  email: string;
  status: 'active' | 'churned' | 'lead';
  totalSpend: number;
  ordersCount: number;
  firstPurchasedAt?: string;
  lastActiveAt?: string;
  notes?: string;
}

export type CampaignStatus = 'draft' | 'awaiting_approval' | 'scheduled' | 'active' | 'completed' | 'paused';
export type MarketingChannel = 'email' | 'social_media' | 'seo' | 'content' | 'ads';

export interface MarketingCampaign {
  id: string;
  businessId: string;
  name: string;
  channel: MarketingChannel;
  status: CampaignStatus;
  targetAudience: string;
  budget: number;
  spent: number;
  scheduledLaunchDate?: string;
  keyCopyOrContent?: string;
  conversionGoal: string;
  createdAt: string;
}

export interface ExpenseRecord {
  id: string;
  businessId: string;
  category: 'software_subscription' | 'hosting_infra' | 'marketing' | 'contractor' | 'legal' | 'hardware' | 'other';
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  notes?: string;
  receiptStatus: 'verified' | 'pending' | 'none';
  createdAt: string;
}

export interface AutomationRule {
  id: string;
  name: string;
  triggerEvent: string;
  actionSummary: string;
  targetDepartment: AIDepartmentType;
  requiresOwnerApproval: boolean;
  isActive: boolean;
  executionCount: number;
  lastExecutedAt?: string;
}

export type ActivitySeverity = 'info' | 'success' | 'warning' | 'critical';

export interface ActivityLog {
  id: string;
  businessId?: string;
  businessName?: string;
  timestamp: string;
  actor: string;
  actorType: 'owner' | 'ai_workforce' | 'system';
  action: string;
  details: string;
  severity: ActivitySeverity;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  isFallback?: boolean;
  source?: 'supabase_edge_function' | 'server_gemini' | 'offline_fallback' | 'error_diagnostic';
  model?: string;
  errorDetails?: {
    status?: string | number;
    instructions?: string;
  };
  actionProposals?: {
    type: ApprovalType;
    title: string;
    description: string;
    targetDepartment: AIDepartmentType;
    data: Record<string, any>;
  }[];
  departmentMentioned?: AIDepartmentType;
}

export interface Conversation {
  id: string;
  title: string;
  businessId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupabaseConfig {
  projectUrl: string;
  anonKey: string;
  isConnected: boolean;
  lastCheckedAt?: string;
}

export interface AIProviderConfig {
  activeProvider: 'gemini_direct' | 'server_proxy' | 'offline_coordinator';
  geminiApiKey?: string;
  customSystemPrompt?: string;
  model: string;
}

export interface UserOwnerProfile {
  name: string;
  email: string;
  roleTitle: string;
  pinCode?: string;
  isLocked: boolean;
}

export type MemoryCategory =
  | 'goal'
  | 'strategy'
  | 'decision'
  | 'preference'
  | 'instruction'
  | 'product_info'
  | 'project_status'
  | 'financial_target'
  | 'approval_policy';

export type MemoryImportance = 'high' | 'medium' | 'low';

export interface BusinessMemory {
  id: string;
  businessId?: string;
  projectId?: string;
  department?: AIDepartmentType | 'global';
  category: MemoryCategory;
  importance: MemoryImportance;
  title: string;
  content: string;
  tags?: string[];
  source: 'conversation_extracted' | 'user_defined' | 'system_initialized';
  isPinned?: boolean;
  createdAt: string;
  updatedAt: string;
}
