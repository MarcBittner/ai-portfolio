/**
 * API Type Definitions
 *
 * Shared types for API requests and responses
 */

// ============================================
// Waitlist API
// ============================================

export type WaitlistSignupRequest = {
  email: string;
  source?: string;
};

export type WaitlistSignupResponse = {
  id: string;
  email: string;
  createdAt: string;
};

export type WaitlistStatsResponse = {
  status: string;
  totalSignups: number;
};

// ============================================
// Generic API Response Types
// ============================================

export type ApiSuccessResponse<T = unknown> = {
  success: true;
  message?: string;
  data: T;
};

export type ApiErrorResponse = {
  success: false;
  error: string;
  details?: unknown;
};

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

// ============================================
// Error Types
// ============================================

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMIT'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export type ApiErrorDetail = {
  code: ApiErrorCode;
  message: string;
  field?: string;
};

// ============================================
// Pagination Types
// ============================================

export type PaginationParams = {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
};

export type PaginatedResponse<T> = {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
};
