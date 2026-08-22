export const HOSTED_WORKSPACE_KEY = 'scenebook:hosted-workspace:v1';
export const HOSTED_SESSION_KEY = 'scenebook:hosted-session:v1';

const ID = /^[a-z0-9][a-z0-9._:-]*$/u;

export interface HostedWorkspaceBinding {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  localProjectId?: string;
}

interface HostedProjectChoice {
  id: string;
  name: string;
  slug: string;
}

export interface HostedConnectionCandidate {
  workspaceId: string;
  workspaceName: string;
  userName: string;
  projects: HostedProjectChoice[];
}

export class HostedApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HostedApiError';
  }
}

function local(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function session(): Storage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

export function readHostedWorkspace(): HostedWorkspaceBinding | null {
  const source = local()?.getItem(HOSTED_WORKSPACE_KEY);
  if (!source) return null;
  try {
    const value = JSON.parse(source) as Partial<HostedWorkspaceBinding>;
    if (
      !ID.test(value.workspaceId ?? '') ||
      !ID.test(value.projectId ?? '') ||
      typeof value.workspaceName !== 'string' ||
      typeof value.projectName !== 'string' ||
      (value.localProjectId !== undefined && !ID.test(value.localProjectId))
    ) {
      return null;
    }
    return value as HostedWorkspaceBinding;
  } catch {
    return null;
  }
}

export function hostedSessionCredential(): string | null {
  return session()?.getItem(HOSTED_SESSION_KEY) ?? null;
}

async function responseError(response: Response): Promise<HostedApiError> {
  let message =
    response.status === 401
      ? 'Your hosted Studio session expired. Reconnect from Settings.'
      : response.status === 403
        ? 'This account does not have access to the hosted workspace.'
        : `The hosted workspace request failed (${response.status}).`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown; code?: unknown };
    };
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (typeof body.error?.code === 'string') code = body.error.code;
  } catch {
    // Keep the bounded status-specific message when the server did not return JSON.
  }
  return new HostedApiError(message, response.status, code);
}

export async function hostedApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const credential = hostedSessionCredential();
  if (!credential) {
    throw new HostedApiError(
      'Your hosted Studio session is not available. Reconnect from Settings.',
      401,
      'session_required',
    );
  }
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${credential}`);
  const response = await fetch(path, {
    ...init,
    headers,
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function hostedAsset(path: string, init: RequestInit = {}): Promise<Response> {
  const credential = hostedSessionCredential();
  if (!credential) {
    throw new HostedApiError(
      'Your hosted Studio session is not available. Reconnect from Settings.',
      401,
      'session_required',
    );
  }
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${credential}`);
  const response = await fetch(path, {
    ...init,
    headers,
    cache: init.method === 'PUT' ? 'no-store' : 'force-cache',
    redirect: 'error',
  });
  if (!response.ok) throw await responseError(response);
  return response;
}

export async function openHostedSession(personalToken: string): Promise<HostedConnectionCandidate> {
  const source = personalToken.trim();
  if (!source) throw new HostedApiError('Enter a personal API token.', 400, 'token_required');
  const response = await fetch('/v1/auth/sessions', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${source}`,
      'content-type': 'application/json',
    },
    body: '{}',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw await responseError(response);
  const created = (await response.json()) as { credential?: unknown };
  if (typeof created.credential !== 'string' || created.credential.length < 32) {
    throw new HostedApiError('The control plane returned an invalid browser session.', 502);
  }
  session()?.setItem(HOSTED_SESSION_KEY, created.credential);
  try {
    const me = await hostedApi<{
      user: { displayName: string };
      principal: { workspaceId: string; projectId?: string; scopes: string[] };
      membership: { role: string } | null;
    }>('/v1/auth/me');
    if (
      !me.principal.scopes.includes('workspace:read') ||
      !me.principal.scopes.includes('project:read') ||
      !me.principal.scopes.includes('project:write') ||
      !me.membership ||
      !['owner', 'editor'].includes(me.membership.role)
    ) {
      throw new HostedApiError(
        'Hosted Studio requires an Owner or Editor token with workspace read, project read, and project write access.',
        403,
        'insufficient_scope',
      );
    }
    const projectsRequest = me.principal.projectId
      ? hostedApi<{ project: HostedProjectChoice }>(
          `/v1/admin/workspaces/${encodeURIComponent(me.principal.workspaceId)}/projects/${encodeURIComponent(me.principal.projectId)}`,
        ).then(({ project }) => ({ projects: [project] }))
      : hostedApi<{ projects: HostedProjectChoice[] }>(
          `/v1/admin/workspaces/${encodeURIComponent(me.principal.workspaceId)}/projects?limit=500`,
        );
    const [result, workspaceResult] = await Promise.all([
      projectsRequest,
      hostedApi<{ workspace: { name: string } }>(
        `/v1/admin/workspaces/${encodeURIComponent(me.principal.workspaceId)}`,
      ),
    ]);
    const projects = result.projects;
    if (projects.length === 0) {
      throw new HostedApiError(
        'This workspace has no accessible projects.',
        404,
        'project_required',
      );
    }
    return {
      workspaceId: me.principal.workspaceId,
      workspaceName: workspaceResult.workspace.name,
      userName: me.user.displayName,
      projects,
    };
  } catch (error) {
    session()?.removeItem(HOSTED_SESSION_KEY);
    throw error;
  }
}

export function activateHostedWorkspace(
  candidate: HostedConnectionCandidate,
  projectId: string,
): HostedWorkspaceBinding {
  const project = candidate.projects.find((value) => value.id === projectId);
  if (!project) throw new HostedApiError('Choose an accessible project.', 400, 'project_required');
  const existing = readHostedWorkspace();
  const activeProjectId = local()?.getItem('scenebook:active-project');
  const binding: HostedWorkspaceBinding = {
    workspaceId: candidate.workspaceId,
    workspaceName: candidate.workspaceName,
    projectId: project.id,
    projectName: project.name,
    ...(existing?.localProjectId || activeProjectId
      ? { localProjectId: existing?.localProjectId ?? activeProjectId! }
      : {}),
  };
  local()?.setItem(HOSTED_WORKSPACE_KEY, JSON.stringify(binding));
  local()?.setItem('scenebook:active-project', binding.projectId);
  return binding;
}

export async function disconnectHostedWorkspace(): Promise<void> {
  try {
    if (hostedSessionCredential()) {
      await hostedApi<void>('/v1/auth/sessions/current', { method: 'DELETE' });
    }
  } catch {
    // Local disconnect still succeeds when a revoked or expired Session cannot be revoked again.
  } finally {
    const binding = readHostedWorkspace();
    session()?.removeItem(HOSTED_SESSION_KEY);
    local()?.removeItem(HOSTED_WORKSPACE_KEY);
    if (binding?.localProjectId) {
      local()?.setItem('scenebook:active-project', binding.localProjectId);
    } else {
      local()?.removeItem('scenebook:active-project');
    }
  }
}
