/**
 * Moltbook API Client
 * Handles all interactions with the Moltbook platform
 */

import pRetry from 'p-retry';
import { createLogger, registerLogger } from '../utils/logger.js';
import type {
  MoltbookAgent,
  MoltbookPost,
  MoltbookComment,
  PaginatedResponse,
  Result,
} from '../types.js';

const logger = createLogger('api');
registerLogger(logger);

/**
 * Normalize a post from the Moltbook API to our internal format.
 * The API may return author as a nested object or as flat fields.
 */
function normalizePost(rawPost: Record<string, unknown>): MoltbookPost {
  // Handle nested author object: { author: { name: "...", id: "..." } }
  const author = rawPost.author as Record<string, unknown> | undefined;

  // Prioritize author.id from nested object, then fall back to flat author_id
  const authorId = (author?.id as string) || (rawPost.author_id as string) || 'unknown';
  const authorName = (author?.name as string) || (rawPost.author_name as string) || undefined;

  // Handle nested submolt object: { submolt: { name: "...", id: "..." } }
  const submolt = rawPost.submolt as Record<string, unknown> | string | undefined;
  const submoltName = typeof submolt === 'object' && submolt !== null
    ? (submolt.name as string)
    : (submolt as string) || (rawPost.submolt_name as string) || 'general';

  return {
    id: rawPost.id as string,
    title: (rawPost.title as string) || '',
    content: (rawPost.content as string) || '',
    author_id: authorId,
    author_name: authorName,
    submolt: submoltName,
    upvotes: (rawPost.upvotes as number) || 0,
    comment_count: (rawPost.comment_count as number) || 0,
    created_at: (rawPost.created_at as string) || new Date().toISOString(),
    url: rawPost.url as string | undefined,
  };
}

export interface MoltbookClientConfig {
  apiKey: string;
  apiUrl: string;
  maxRetries?: number;
  retryDelay?: number;
}

export interface CreatePostParams {
  submolt: string;
  title: string;
  content: string;
}

export interface CreateCommentParams {
  postId: string;
  content: string;
  parentId?: string;
}

export interface GetPostsParams {
  submolt?: string;
  sort?: 'hot' | 'new' | 'top';
  page?: number;
  limit?: number;
}

export class MoltbookClient {
  private apiKey: string;
  private apiUrl: string;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: MoltbookClientConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl.replace(/\/$/, ''); // Remove trailing slash
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  // ==========================================================================
  // HTTP Helper Methods
  // ==========================================================================

  private async request<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
      ...(body && { body: JSON.stringify(body) }),
    };

    const response = await pRetry(
      async () => {
        const res = await fetch(url, options);

        if (res.status === 429) {
          // Rate limited - throw to trigger retry with backoff
          const error = new Error('Rate limited');
          (error as Error & { retryAfter?: number }).retryAfter =
            parseInt(res.headers.get('Retry-After') || '60', 10);
          throw error;
        }

        if (!res.ok) {
          const errorBody = await res.text();
          throw new Error(`API error ${res.status}: ${errorBody}`);
        }

        return res.json();
      },
      {
        retries: this.maxRetries,
        minTimeout: this.retryDelay,
        maxTimeout: this.retryDelay * 8,
        onFailedAttempt: (error) => {
          logger.warn('api_request_retry', {
            endpoint,
            attempt: error.attemptNumber,
            retriesLeft: error.retriesLeft,
            error: error.message,
          });
        },
      }
    );

    return response as T;
  }

  private async get<T>(endpoint: string): Promise<T> {
    return this.request<T>('GET', endpoint);
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', endpoint, body);
  }

  private async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>('DELETE', endpoint);
  }

  // ==========================================================================
  // Agent Methods
  // ==========================================================================

  /**
   * Get the current authenticated agent's info
   */
  async getMe(): Promise<Result<MoltbookAgent>> {
    try {
      const agent = await this.get<MoltbookAgent>('/agents/me');
      logger.debug('get_me_success', { agentId: agent.id });
      return { success: true, data: agent };
    } catch (error) {
      logger.error('get_me_failed', { error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  /**
   * Get an agent by ID
   */
  async getAgent(agentId: string): Promise<Result<MoltbookAgent>> {
    try {
      const agent = await this.get<MoltbookAgent>(`/agents/${agentId}`);
      logger.debug('get_agent_success', { agentId });
      return { success: true, data: agent };
    } catch (error) {
      logger.error('get_agent_failed', { agentId, error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  /**
   * Check agent's claim status
   */
  async getAgentStatus(): Promise<Result<{ claimed: boolean; verified: boolean }>> {
    try {
      const status = await this.get<{ claimed: boolean; verified: boolean }>('/agents/status');
      logger.debug('get_status_success', status);
      return { success: true, data: status };
    } catch (error) {
      logger.error('get_status_failed', { error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  // ==========================================================================
  // Post Methods
  // ==========================================================================

  /**
   * Get posts from Moltbook
   */
  async getPosts(params: GetPostsParams = {}): Promise<Result<PaginatedResponse<MoltbookPost>>> {
    try {
      const queryParams = new URLSearchParams();
      if (params.submolt) queryParams.set('submolt', params.submolt);
      if (params.sort) queryParams.set('sort', params.sort);
      if (params.page) queryParams.set('page', params.page.toString());
      if (params.limit) queryParams.set('limit', params.limit.toString());

      const query = queryParams.toString();
      const endpoint = `/posts${query ? `?${query}` : ''}`;

      const response = await this.get<PaginatedResponse<Record<string, unknown>>>(endpoint);
      // Moltbook API returns 'posts', normalize to 'items' for internal use
      const rawPosts = (response.posts || response.items || []) as Record<string, unknown>[];
      // Normalize each post to handle nested author objects
      const posts = rawPosts.map(normalizePost);

      const normalizedResponse: PaginatedResponse<MoltbookPost> = {
        ...response,
        items: posts,
        posts: posts,
      };

      logger.debug('get_posts_success', {
        submolt: params.submolt,
        count: posts.length,
      });
      return { success: true, data: normalizedResponse };
    } catch (error) {
      logger.error('get_posts_failed', { params, error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  /**
   * Get a single post by ID
   */
  async getPost(postId: string): Promise<Result<MoltbookPost>> {
    try {
      const rawPost = await this.get<Record<string, unknown>>(`/posts/${postId}`);
      const post = normalizePost(rawPost);
      logger.debug('get_post_success', { postId });
      return { success: true, data: post };
    } catch (error) {
      logger.error('get_post_failed', { postId, error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  /**
   * Create a new post
   */
  async createPost(params: CreatePostParams): Promise<Result<MoltbookPost>> {
    try {
      const post = await this.post<MoltbookPost>('/posts', {
        submolt: params.submolt,
        title: params.title,
        content: params.content,
      });
      logger.info('create_post_success', {
        postId: post.id,
        submolt: params.submolt,
        title: params.title.slice(0, 50),
      });
      return { success: true, data: post };
    } catch (error) {
      logger.error('create_post_failed', {
        submolt: params.submolt,
        error: (error as Error).message,
      });
      return { success: false, error: error as Error };
    }
  }

  /**
   * Delete a post (own posts only)
   */
  async deletePost(postId: string): Promise<Result<void>> {
    try {
      await this.delete(`/posts/${postId}`);
      logger.info('delete_post_success', { postId });
      return { success: true };
    } catch (error) {
      logger.error('delete_post_failed', { postId, error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  // ==========================================================================
  // Comment Methods
  // ==========================================================================

  /**
   * Get comments for a post
   */
  async getComments(postId: string): Promise<Result<MoltbookComment[]>> {
    try {
      const comments = await this.get<MoltbookComment[]>(`/posts/${postId}/comments`);
      logger.debug('get_comments_success', { postId, count: comments.length });
      return { success: true, data: comments };
    } catch (error) {
      logger.error('get_comments_failed', { postId, error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  /**
   * Create a comment on a post
   */
  async createComment(params: CreateCommentParams): Promise<Result<MoltbookComment>> {
    try {
      const comment = await this.post<MoltbookComment>(`/posts/${params.postId}/comments`, {
        content: params.content,
        ...(params.parentId && { parent_id: params.parentId }),
      });
      logger.info('create_comment_success', {
        commentId: comment.id,
        postId: params.postId,
        contentPreview: params.content.slice(0, 50),
      });
      return { success: true, data: comment };
    } catch (error) {
      logger.error('create_comment_failed', {
        postId: params.postId,
        error: (error as Error).message,
      });
      return { success: false, error: error as Error };
    }
  }

  /**
   * Upvote a comment
   */
  async upvoteComment(commentId: string): Promise<Result<void>> {
    try {
      await this.post(`/comments/${commentId}/upvote`, {});
      logger.debug('upvote_comment_success', { commentId });
      return { success: true };
    } catch (error) {
      logger.error('upvote_comment_failed', { commentId, error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  // ==========================================================================
  // Submolt Methods
  // ==========================================================================

  /**
   * Get list of submolts
   */
  async getSubmolts(): Promise<Result<Array<{ name: string; description: string; memberCount: number }>>> {
    try {
      const submolts = await this.get<Array<{ name: string; description: string; member_count: number }>>('/submolts');
      const formatted = submolts.map((s) => ({
        name: s.name,
        description: s.description,
        memberCount: s.member_count,
      }));
      logger.debug('get_submolts_success', { count: submolts.length });
      return { success: true, data: formatted };
    } catch (error) {
      logger.error('get_submolts_failed', { error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  /**
   * Get a specific submolt
   */
  async getSubmolt(name: string): Promise<Result<{ name: string; description: string; memberCount: number }>> {
    try {
      const submolt = await this.get<{ name: string; description: string; member_count: number }>(`/submolts/${name}`);
      logger.debug('get_submolt_success', { name });
      return {
        success: true,
        data: {
          name: submolt.name,
          description: submolt.description,
          memberCount: submolt.member_count,
        },
      };
    } catch (error) {
      logger.error('get_submolt_failed', { name, error: (error as Error).message });
      return { success: false, error: error as Error };
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Check if the API is reachable and authenticated
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Use /agents/status which is faster and more reliable
      const response = await this.get<{ success: boolean; status: string }>('/agents/status');
      return response.success === true;
    } catch {
      return false;
    }
  }

  /**
   * Get multiple posts across multiple submolts
   */
  async getPostsFromSubmolts(
    submolts: string[],
    sort: 'hot' | 'new' | 'top' = 'new',
    limitPerSubmolt: number = 25
  ): Promise<MoltbookPost[]> {
    const allPosts: MoltbookPost[] = [];

    for (const submolt of submolts) {
      const result = await this.getPosts({
        submolt,
        sort,
        limit: limitPerSubmolt,
      });

      if (result.success && result.data) {
        const posts = result.data.items || result.data.posts || [];
        allPosts.push(...posts);
      }
    }

    // Sort by created_at descending
    allPosts.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return allPosts;
  }
}
