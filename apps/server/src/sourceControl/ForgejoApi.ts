import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import {
  ForgejoPullRequestListSchema,
  ForgejoPullRequestSchema,
  normalizeForgejoPullRequestRecord,
  type NormalizedForgejoPullRequestRecord,
} from "./forgejoPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

// Forgejo is self-hosted, so there is no default API base URL: an absent
// T3CODE_FORGEJO_API_BASE_URL means the provider is unconfigured.
const ForgejoApiEnvConfig = Config.all({
  baseUrl: Config.string("T3CODE_FORGEJO_API_BASE_URL").pipe(Config.option),
  apiToken: Config.string("T3CODE_FORGEJO_API_TOKEN").pipe(Config.option),
});

const ForgejoApiOperation = Schema.Literals([
  "resolveRepository",
  "getRepository",
  "getAuthenticatedUser",
  "getPullRequest",
  "listPullRequests",
  "createRepository",
  "createPullRequest",
  "probeAuth",
  "checkoutPullRequest",
]);
type ForgejoApiOperation = typeof ForgejoApiOperation.Type;

export class ForgejoConfigurationError extends Schema.TaggedErrorClass<ForgejoConfigurationError>()(
  "ForgejoConfigurationError",
  {
    operation: ForgejoApiOperation,
  },
) {
  override get message(): string {
    return `Forgejo API failed in ${this.operation}: T3CODE_FORGEJO_API_BASE_URL is not configured.`;
  }
}

export class ForgejoRepositoryLocatorError extends Schema.TaggedErrorClass<ForgejoRepositoryLocatorError>()(
  "ForgejoRepositoryLocatorError",
  {
    repository: Schema.String,
  },
) {
  override get message(): string {
    return "Forgejo API failed in createRepository: Forgejo repositories must be specified as owner/repository.";
  }
}

export class ForgejoRequestError extends Schema.TaggedErrorClass<ForgejoRequestError>()(
  "ForgejoRequestError",
  {
    operation: ForgejoApiOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Forgejo API failed in ${this.operation}: Failed to send the Forgejo request.`;
  }
}

export class ForgejoResponseError extends Schema.TaggedErrorClass<ForgejoResponseError>()(
  "ForgejoResponseError",
  {
    operation: ForgejoApiOperation,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Forgejo API failed in ${this.operation}: Forgejo returned HTTP ${this.status}.`;
  }
}

export class ForgejoResponseBodyReadError extends Schema.TaggedErrorClass<ForgejoResponseBodyReadError>()(
  "ForgejoResponseBodyReadError",
  {
    operation: ForgejoApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Forgejo API failed in ${this.operation}: Forgejo returned HTTP ${this.status}.`;
  }
}

export class ForgejoResponseDecodeError extends Schema.TaggedErrorClass<ForgejoResponseDecodeError>()(
  "ForgejoResponseDecodeError",
  {
    operation: ForgejoApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Forgejo API failed in ${this.operation}: Forgejo returned invalid JSON for the requested resource.`;
  }
}

export class ForgejoRepositoryVcsResolveError extends Schema.TaggedErrorClass<ForgejoRepositoryVcsResolveError>()(
  "ForgejoRepositoryVcsResolveError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Forgejo API failed in resolveRepository: Failed to resolve VCS repository for ${this.cwd}.`;
  }
}

export class ForgejoRepositoryRemotesListError extends Schema.TaggedErrorClass<ForgejoRepositoryRemotesListError>()(
  "ForgejoRepositoryRemotesListError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Forgejo API failed in resolveRepository: Failed to list remotes for ${this.cwd}.`;
  }
}

export class ForgejoRepositoryRemoteNotFoundError extends Schema.TaggedErrorClass<ForgejoRepositoryRemoteNotFoundError>()(
  "ForgejoRepositoryRemoteNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `Forgejo API failed in resolveRepository: No Forgejo repository remote was detected for ${this.cwd}.`;
  }
}

export class ForgejoPullRequestBodyReadError extends Schema.TaggedErrorClass<ForgejoPullRequestBodyReadError>()(
  "ForgejoPullRequestBodyReadError",
  {
    cwd: Schema.String,
    bodyFile: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Forgejo API failed in createPullRequest: Failed to read pull request body file ${this.bodyFile}.`;
  }
}

export class ForgejoCheckoutError extends Schema.TaggedErrorClass<ForgejoCheckoutError>()(
  "ForgejoCheckoutError",
  {
    cwd: Schema.String,
    reference: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Forgejo API failed in checkoutPullRequest: Failed to check out the Forgejo pull request.";
  }
}

export const ForgejoApiError = Schema.Union([
  ForgejoConfigurationError,
  ForgejoRepositoryLocatorError,
  ForgejoRequestError,
  ForgejoResponseError,
  ForgejoResponseBodyReadError,
  ForgejoResponseDecodeError,
  ForgejoRepositoryVcsResolveError,
  ForgejoRepositoryRemotesListError,
  ForgejoRepositoryRemoteNotFoundError,
  ForgejoPullRequestBodyReadError,
  ForgejoCheckoutError,
]);
export type ForgejoApiError = typeof ForgejoApiError.Type;
export const isForgejoApiError = Schema.is(ForgejoApiError);

const RawForgejoRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  html_url: Schema.optional(TrimmedNonEmptyString),
  clone_url: Schema.optional(TrimmedNonEmptyString),
  ssh_url: Schema.optional(TrimmedNonEmptyString),
  default_branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ForgejoUserSchema = Schema.Struct({
  login: Schema.optional(TrimmedNonEmptyString),
  full_name: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});

export interface ForgejoRepositoryLocator {
  readonly owner: string;
  readonly repoSlug: string;
}

export class ForgejoApi extends Context.Service<
  ForgejoApi,
  {
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedForgejoPullRequestRecord>, ForgejoApiError>;
    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<NormalizedForgejoPullRequestRecord, ForgejoApiError>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, ForgejoApiError>;
    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, ForgejoApiError>;
    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, ForgejoApiError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<string | null, ForgejoApiError>;
    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, ForgejoApiError>;
  }
>()("t3/sourceControl/ForgejoApi") {}

function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pulls|pull|pr)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function sourceOwner(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  return SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
}

// Forgejo only exposes open/closed/all as list filters; merged pull requests
// are closed pull requests with the merged flag set, so "merged" and "closed"
// both query the closed list and are separated after normalization.
function toForgejoListState(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "open";
    case "closed":
    case "merged":
      return "closed";
    case "all":
      return "all";
  }
}

function parseForgejoRepositorySlug(value: string): ForgejoRepositoryLocator | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const owner = parts.at(-2);
  const repoSlug = parts.at(-1);
  return owner && repoSlug ? { owner, repoSlug } : null;
}

function requireRepositoryLocator(
  repository: string,
): Effect.Effect<ForgejoRepositoryLocator, ForgejoApiError> {
  const locator = parseForgejoRepositorySlug(repository);
  return locator
    ? Effect.succeed(locator)
    : Effect.fail(
        new ForgejoRepositoryLocatorError({
          repository,
        }),
      );
}

function parseForgejoRemoteUrl(remoteUrl: string): ForgejoRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.startsWith("git@")) {
    const pathStart = trimmed.indexOf(":");
    return pathStart < 0 ? null : parseForgejoRepositorySlug(trimmed.slice(pathStart + 1));
  }

  try {
    return parseForgejoRepositorySlug(new URL(trimmed).pathname);
  } catch {
    return null;
  }
}

function normalizeRepositoryCloneUrls(
  raw: typeof RawForgejoRepositorySchema.Type,
): SourceControlRepositoryCloneUrls {
  const httpClone = raw.clone_url ?? raw.html_url;

  return {
    nameWithOwner: raw.full_name,
    url: httpClone ?? raw.full_name,
    sshUrl: raw.ssh_url ?? httpClone ?? raw.full_name,
  };
}

function shouldPreferSshRemote(originRemoteUrl: string | null): boolean {
  const trimmed = originRemoteUrl?.trim() ?? "";
  return trimmed.startsWith("git@") || trimmed.startsWith("ssh://");
}

function selectCloneUrl(input: {
  readonly cloneUrls: SourceControlRepositoryCloneUrls;
  readonly originRemoteUrl: string | null;
}): string {
  return shouldPreferSshRemote(input.originRemoteUrl)
    ? input.cloneUrls.sshUrl
    : input.cloneUrls.url;
}

function checkoutBranchName(input: {
  readonly pullRequestId: number;
  readonly headBranch: string;
  readonly isCrossRepository: boolean;
}): string {
  if (!input.isCrossRepository) {
    return input.headBranch;
  }

  return `t3code/pr-${input.pullRequestId}/${sanitizeBranchFragment(input.headBranch)}`;
}

function repositoryNameWithOwner(
  repository: Schema.Schema.Type<typeof ForgejoPullRequestSchema>["head"]["repo"],
): string | null {
  const fullName = repository?.full_name?.trim() ?? "";
  return fullName.length > 0 ? fullName : null;
}

function repositoryOwnerName(repositoryName: string): string {
  return repositoryName.split("/")[0]?.trim() || "forgejo";
}

function hostFromBaseUrl(baseUrl: Option.Option<string>): Option.Option<string> {
  return Option.flatMap(baseUrl, (value) => {
    try {
      return nonEmpty(new URL(value).host);
    } catch {
      return Option.none();
    }
  });
}

function authFromConfig(
  config: Config.Success<typeof ForgejoApiEnvConfig>,
): SourceControlProviderAuth {
  if (Option.isSome(config.baseUrl) && Option.isSome(config.apiToken)) {
    return {
      status: "unknown",
      account: Option.none(),
      host: hostFromBaseUrl(config.baseUrl),
      detail: Option.some("Forgejo API token is configured."),
    };
  }

  return {
    status: "unauthenticated",
    account: Option.none(),
    host: hostFromBaseUrl(config.baseUrl),
    detail: Option.some("Set T3CODE_FORGEJO_API_BASE_URL and T3CODE_FORGEJO_API_TOKEN."),
  };
}

function responseError(
  operation: ForgejoApiOperation,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, ForgejoApiError> {
  return response.text.pipe(
    Effect.mapError(
      (cause) =>
        new ForgejoResponseBodyReadError({
          operation,
          status: response.status,
          cause,
        }),
    ),
    Effect.flatMap((body) =>
      Effect.fail(
        new ForgejoResponseError({
          operation,
          status: response.status,
          responseBodyLength: body.length,
        }),
      ),
    ),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ForgejoApiEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const requireApiUrl = (
    operation: ForgejoApiOperation,
  ): Effect.Effect<(path: string) => string, ForgejoApiError> =>
    Option.match(config.baseUrl, {
      onNone: () => Effect.fail(new ForgejoConfigurationError({ operation })),
      onSome: (baseUrl) =>
        Effect.succeed((path: string) => `${baseUrl.replace(/\/+$/u, "")}${path}`),
    });

  const withAuth = (request: HttpClientRequest.HttpClientRequest) => {
    if (Option.isSome(config.apiToken)) {
      // Forgejo access tokens use the Gitea-style `token` scheme, not `Bearer`.
      return request.pipe(
        HttpClientRequest.setHeader("Authorization", `token ${config.apiToken.value}`),
      );
    }
    return request;
  };

  const decodeResponse = <S extends Schema.Top>(
    operation: ForgejoApiOperation,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(schema)(success).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoResponseDecodeError({
                operation,
                status: success.status,
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: ForgejoApiOperation,
    request: (apiUrl: (path: string) => string) => HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]> =>
    requireApiUrl(operation).pipe(
      Effect.flatMap((apiUrl) =>
        httpClient.execute(withAuth(request(apiUrl).pipe(HttpClientRequest.acceptJson))).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoRequestError({
                operation,
                cause,
              }),
          ),
          Effect.flatMap((response) => decodeResponse(operation, schema, response)),
        ),
      ),
    );

  const resolveRepository = Effect.fn("ForgejoApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    const fromRepository =
      input.repository !== undefined ? parseForgejoRepositorySlug(input.repository) : null;
    if (fromRepository) return fromRepository;

    const fromContext =
      input.context?.provider.kind === "forgejo"
        ? parseForgejoRemoteUrl(input.context.remoteUrl)
        : null;
    if (fromContext) return fromContext;

    const handle = yield* vcsRegistry.resolve({ cwd: input.cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoRepositoryVcsResolveError({
            cwd: input.cwd,
            cause,
          }),
      ),
    );
    const remotes = yield* handle.driver.listRemotes(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoRepositoryRemotesListError({
            cwd: input.cwd,
            cause,
          }),
      ),
    );

    for (const remote of remotes.remotes) {
      if (detectSourceControlProviderFromRemoteUrl(remote.url)?.kind !== "forgejo") continue;
      const parsed = parseForgejoRemoteUrl(remote.url);
      if (parsed) return parsed;
    }

    return yield* new ForgejoRepositoryRemoteNotFoundError({
      cwd: input.cwd,
    });
  });

  const getRepositoryFromLocator = (repository: ForgejoRepositoryLocator) =>
    executeJson(
      "getRepository",
      (apiUrl) =>
        HttpClientRequest.get(
          apiUrl(
            `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repoSlug)}`,
          ),
        ),
      RawForgejoRepositorySchema,
    );

  const getRepository = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) => resolveRepository(input).pipe(Effect.flatMap(getRepositoryFromLocator));

  const getRawPullRequestFromRepository = (
    repository: ForgejoRepositoryLocator,
    reference: string,
  ) =>
    executeJson(
      "getPullRequest",
      (apiUrl) =>
        HttpClientRequest.get(
          apiUrl(
            `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repoSlug)}/pulls/${encodeURIComponent(normalizeChangeRequestId(reference))}`,
          ),
        ),
      ForgejoPullRequestSchema,
    );

  const getRawPullRequest = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) =>
    resolveRepository(input).pipe(
      Effect.flatMap((repository) => getRawPullRequestFromRepository(repository, input.reference)),
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    git.readConfigValue(cwd, key).pipe(Effect.orElseSucceed(() => null));

  const resolveCheckoutRemote = Effect.fn("ForgejoApi.resolveCheckoutRemote")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly destinationRepository: ForgejoRepositoryLocator;
    readonly sourceRepositoryName: string;
    readonly isCrossRepository: boolean;
  }) {
    if (
      input.context?.provider.kind === "forgejo" &&
      !input.isCrossRepository &&
      parseForgejoRemoteUrl(input.context.remoteUrl) !== null
    ) {
      return input.context.remoteName;
    }

    if (!input.isCrossRepository) {
      const remoteName = yield* git
        .resolvePrimaryRemoteName(input.cwd)
        .pipe(Effect.orElseSucceed(() => null));
      if (remoteName) return remoteName;
    }

    const cloneUrls = yield* getRepository({
      cwd: input.cwd,
      repository: input.sourceRepositoryName,
      ...(input.context ? { context: input.context } : {}),
    }).pipe(Effect.map(normalizeRepositoryCloneUrls));
    const originRemoteUrl = yield* readConfigValueNullable(input.cwd, "remote.origin.url");
    return yield* git.ensureRemote({
      cwd: input.cwd,
      preferredName: input.isCrossRepository
        ? repositoryOwnerName(input.sourceRepositoryName)
        : input.destinationRepository.owner,
      url: selectCloneUrl({ cloneUrls, originRemoteUrl }),
    });
  });

  return ForgejoApi.of({
    probeAuth: executeJson(
      "probeAuth",
      (apiUrl) => HttpClientRequest.get(apiUrl("/user")),
      ForgejoUserSchema,
    ).pipe(
      Effect.map((user) => ({
        status: "authenticated" as const,
        account: nonEmpty(user.login ?? user.full_name ?? user.email),
        host: hostFromBaseUrl(config.baseUrl),
        detail: Option.none<string>(),
      })),
      Effect.orElseSucceed(() => authFromConfig(config)),
    ),
    listPullRequests: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "listPullRequests",
            (apiUrl) =>
              HttpClientRequest.get(
                apiUrl(
                  `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repoSlug)}/pulls`,
                ),
                {
                  urlParams: {
                    state: toForgejoListState(input.state),
                    limit: String(Math.max(1, Math.min(input.limit ?? 20, 50))),
                  },
                },
              ),
            ForgejoPullRequestListSchema,
          ),
        ),
        // The Forgejo list endpoint cannot filter by head branch or separate
        // merged from closed pull requests, so both are narrowed here.
        Effect.map((list) => {
          const branch = SourceControlProvider.sourceBranch(input);
          return list
            .map(normalizeForgejoPullRequestRecord)
            .filter(
              (record) =>
                record.headRefName === branch &&
                (input.state === "all" || record.state === input.state),
            );
        }),
      ),
    getPullRequest: (input) =>
      getRawPullRequest(input).pipe(Effect.map(normalizeForgejoPullRequestRecord)),
    getRepositoryCloneUrls: (input) =>
      getRepository(input).pipe(Effect.map(normalizeRepositoryCloneUrls)),
    createRepository: (input) =>
      requireRepositoryLocator(input.repository).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "getAuthenticatedUser",
            (apiUrl) => HttpClientRequest.get(apiUrl("/user")),
            ForgejoUserSchema,
          ).pipe(
            Effect.flatMap((user) =>
              executeJson(
                "createRepository",
                (apiUrl) =>
                  HttpClientRequest.post(
                    apiUrl(
                      // Forgejo has no owner-agnostic create endpoint: personal
                      // repositories go through /user/repos, everything else
                      // through the organization route.
                      user.login === repository.owner
                        ? "/user/repos"
                        : `/orgs/${encodeURIComponent(repository.owner)}/repos`,
                    ),
                  ).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      name: repository.repoSlug,
                      private: input.visibility === "private",
                    }),
                  ),
                RawForgejoRepositorySchema,
              ),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const body = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoPullRequestBodyReadError({
                cwd: input.cwd,
                bodyFile: input.bodyFile,
                cause,
              }),
          ),
        );
        const owner = sourceOwner(input);
        const branch = SourceControlProvider.sourceBranch(input);

        yield* executeJson(
          "createPullRequest",
          (apiUrl) =>
            HttpClientRequest.post(
              apiUrl(
                `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repoSlug)}/pulls`,
              ),
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                title: input.title,
                body,
                head: owner ? `${owner}:${branch}` : branch,
                base: input.target?.refName ?? input.baseBranch,
              }),
            ),
          ForgejoPullRequestSchema,
        );
      }),
    getDefaultBranch: (input) =>
      getRepository(input).pipe(Effect.map((repository) => repository.default_branch ?? null)),
    // Forgejo pull requests are Git-backed and Forgejo does not provide an
    // official checkout CLI. This provider-local path uses GitVcsDriver as a
    // narrow escape hatch to materialize Forgejo PR refs. Do not generalize this
    // as the source-control provider model: if we support non-Git-compatible
    // hosting providers or native JJ/Sapling checkout flows, move this into a
    // VCS-specific change-request checkout capability.
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const destinationRepository = yield* resolveRepository(input);
        const pullRequest = yield* getRawPullRequestFromRepository(
          destinationRepository,
          input.reference,
        );
        const destinationRepositoryName =
          repositoryNameWithOwner(pullRequest.base.repo) ??
          `${destinationRepository.owner}/${destinationRepository.repoSlug}`;
        const sourceRepositoryName =
          repositoryNameWithOwner(pullRequest.head.repo) ?? destinationRepositoryName;
        const isCrossRepository = sourceRepositoryName !== destinationRepositoryName;
        const remoteName = yield* resolveCheckoutRemote({
          cwd: input.cwd,
          destinationRepository,
          sourceRepositoryName,
          isCrossRepository,
          ...(input.context ? { context: input.context } : {}),
        });
        const remoteBranch = pullRequest.head.ref;
        const localBranch = checkoutBranchName({
          pullRequestId: pullRequest.number,
          headBranch: remoteBranch,
          isCrossRepository,
        });
        const localBranchNames = yield* git.listLocalBranchNames(input.cwd);
        const localBranchExists = localBranchNames.includes(localBranch);

        if (input.force === true || !localBranchExists) {
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch,
            localBranch,
          });
        } else {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch,
          });
        }

        yield* git.setBranchUpstream({
          cwd: input.cwd,
          branch: localBranch,
          remoteName,
          remoteBranch,
        });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          isForgejoApiError(cause)
            ? cause
            : new ForgejoCheckoutError({
                cwd: input.cwd,
                reference: input.reference,
                cause,
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(ForgejoApi, make);
